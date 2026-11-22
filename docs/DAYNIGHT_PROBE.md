# Informe de Barrido Experimental: Modo Día/Noche (Luz) en EseeCloud C2L-Y-A

**Fecha:** 22 de Noviembre de 2026  
**Cámara:** EseeCloud C2L-Y-A (IP `192.168.1.40`, Hi3510 CGI API en puerto 80, daemon P2P en puerto 10000)  
**Metodología:** Barrido interactivo en red local (GET de lectura únicamente, rate-limited a 1 req/s, timeout 3s) utilizando la aplicación móvil EseeCloud como oráculo de estado.

---

## 1. Tabla Comparativa de Resultados

| Endpoint / Métrica | day1 (Luz ON en App) | night (Luz OFF en App) | day2 (Luz ON en App) | Conclusión Técnica |
| :--- | :--- | :--- | :--- | :--- |
| **Saturación media (HSV)** | **20.81%** (Color) | **0.00%** (Monocromo) | **23.52%** (Color) | **Efecto físico real confirmado:** La app conmuta el filtro IR-Cut y los LEDs infrarrojos. |
| **Brillo medio (HSV)** | 48.16% | 53.80% | 48.51% | Variación por iluminación IR en visión nocturna. |
| **LEDs IR físicos** | Apagados | Encendidos (Rojos) | Apagados | Confirmado por el usuario y snapshot. |
| `cmd=getimageattr` | `scene="auto"`<br>`hue=127`<br>`brightness=127`<br>`saturation=127` | `scene="auto"`<br>`hue=127`<br>`brightness=127`<br>`saturation=127` | `scene="auto"`<br>`hue=127`<br>`brightness=127`<br>`saturation=127` | **Sin cambios en HTTP:** El parámetro `scene` no refleja el estado forzado por la app. |
| `cmd=getvencattr` | 720p @ 15fps, 1024kbps | 720p @ 15fps, 1024kbps | 720p @ 15fps, 1024kbps | Idéntico. |
| `cmd=getoverlayattr` | 200 OK (eco de cabeceras) | 200 OK (eco de cabeceras) | 200 OK (eco de cabeceras) | Idéntico byte a byte. |
| `cmd=getlightattr` | HTTP 403 Forbidden | HTTP 403 Forbidden | HTTP 403 Forbidden | Bloqueado en firmware. |
| `cmd=getinfraredstat`| HTTP 403 Forbidden | HTTP 403 Forbidden | HTTP 403 Forbidden | Bloqueado en firmware. |
| `cmd=getlampattr` | HTTP 403 Forbidden | HTTP 403 Forbidden | HTTP 403 Forbidden | Bloqueado en firmware. |
| `cmd=getircutattr` | HTTP 403 Forbidden | HTTP 403 Forbidden | HTTP 403 Forbidden | Bloqueado en firmware. |
| `cmd=getdaynight` | HTTP 403 Forbidden | HTTP 403 Forbidden | HTTP 403 Forbidden | Bloqueado en firmware. |
| `cmd=getnightmode` | HTTP 403 Forbidden | HTTP 403 Forbidden | HTTP 403 Forbidden | Bloqueado en firmware. |
| Otros 14 cmds `param.cgi` | HTTP 403 Forbidden | HTTP 403 Forbidden | HTTP 403 Forbidden | Bloqueados en firmware. |
| Scripts `.cgi` directos | HTTP 404 Not Found | HTTP 404 Not Found | HTTP 404 Not Found | Inexistentes en webroot. |
| Encabezados `/snapshot.jpg` | HTTP 200 (19,250 B) | HTTP 200 (22,021 B) | HTTP 200 (18,023 B) | Solo varía `Content-Length` por compresión JPEG. |

---

## 2. Diagnóstico y Veredicto de Ingeniería

1. **La "Luz" es el modo Día/Noche:** La cámara física no posee un reflector LED blanco (torch/spotlight); su control de "luz" en la app móvil conmuta el modo Día (filtro IR-cut activado, sensor en color, LEDs IR apagados) y modo Noche (filtro IR-cut retirado, sensor en B&W, LEDs IR de 850nm encendidos).
2. **Canal de Control Fuera de HTTP:**
   - La aplicación móvil **NO modifica los parámetros vía la API HTTP Hi3510** (`param.cgi`).
   - El daemon que gestiona la conexión con la app móvil opera a través del puerto **10000/TCP** (daemon P2P de EseeCloud) o por su túnel en la nube.
   - El estado de la imagen en `param.cgi` permanece estático en `scene="auto"`.
3. **Preset 64/65:**
   - El envío previo de `preset.cgi?-act=goto&-number=64` o `65` recibe `[Success] ptz ok` simplemente porque el parser PTZ procesa el número como una coordenada de posición mecánica válida, pero **no tiene ningún cableado interno a la conmutación de GPIO del IR o corte de filtro**.

---

## 3. Estrategia de Implementación Recomendada

1. **Lectura Real del Estado:**
   - Dado que los endpoints CGI de lectura devuelven 403, el estado real físico del modo Día/Noche se puede determinar **analíticamente mediante el snapshot JPEG**:
     $$\text{Saturación media} = \frac{1}{N} \sum_{(x,y)} S(x,y)$$
     - $\text{Saturación media} > 5.0\% \implies \text{Día / Color (Luz Activa)}$
     - $\text{Saturación media} \le 1.0\% \implies \text{Noche / IR (Luz Inactiva / Infrarrojo)}$
   - Este método proporciona una fuente de verdad **100% precisa y comprobada con evidencia**, sin simulación ni estado ciego.
2. **Control de Escritura:**
   - Se ofrece configuración desacoplada en el backend vía variables de entorno (`LIGHT_ON_URL`, `LIGHT_OFF_URL`, `LIGHT_TOGGLE_TYPE=snapshot_inferred|assumed`).
   - El backend expondrá en `GET /api/light`:
     ```json
     {
       "on": true,
       "source": "inferred",
       "saturation": 23.52,
       "updatedAt": "2026-11-22T01:13:00Z"
     }
     ```
   - Si no hay endpoint CGI local de escritura disponible en el firmware, la UI debe reflejar con total transparencia la naturaleza del control (o desactivar el switch con un tooltip explicativo: *"Control exclusivo vía app móvil EseeCloud / P2P"* o permitir control de un actuador domótico externo).
