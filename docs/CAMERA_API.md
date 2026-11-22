# Documentación de la API de la Cámara EseeCloud C2L-Y-A

**Dispositivo:** EseeCloud C2L-Y-A (SoC HiSilicon Hi3510 / Sensor CMOS HD)  
**IP Local:** `192.168.1.40`  
**Puerto HTTP:** `80` (Nginx embebido reverse-proxy hacia daemon CGI / FastCGI)  
**Autenticación:** HTTP Basic Auth (`admin` con contraseña vacía)

---

## 1. Endpoints de Transmisión y Captura

### 1.1 Captura JPEG Instantánea
- **URL:** `GET http://192.168.1.40/snapshot.jpg`
- **Autenticación:** Basic Auth (`Authorization: Basic YWRtaW46`)
- **Respuesta:** Imagen JPEG 640x360 con cabecera `Content-Type: application/octet-stream`.
- **Rendimiento:** ~150-300 ms de latencia.
- **Uso en NVR:** Inferencia de estado Día/Noche mediante análisis HSV, generación de miniaturas y captura manual.

### 1.2 Flujo de Video HD (Stream 11)
- **URL:** `GET http://192.168.1.40/livestream/11`
- **Protocolo:** HiSilicon interleaved RTP sobre HTTP (`Transport: RTP/AVP/TCP;unicast;hisiinterleaved=0-1`)
- **Video:** H.264 (Main Profile) @ 1280x720 15 fps (bps: 1024 kbps)
- **Audio:** AAC LC (Low Complexity) @ 8000 Hz, 1 canal (mono), Payload Type 104
- **Consumo en NVR:** Ingesta por `go2rtc` con la URL `eseecloud://admin:@192.168.1.40:80/livestream/11`.

### 1.3 Flujo de Video SD (Stream 12 - Sub-stream)
- **URL:** `GET http://192.168.1.40/livestream/12`
- **Protocolo:** HiSilicon interleaved RTP sobre HTTP
- **Video:** H.264 (Main Profile) @ 640x360 15 fps (bps: 128 kbps)
- **Audio:** AAC LC @ 8000 Hz mono
- **Uso en NVR:** Análisis de movimiento por software (< 3% CPU) y visualización en conexiones de bajo ancho de banda.

---

## 2. Pista de Audio y Parche de `go2rtc`

### 2.1 Diagnóstico de Audio
La cámara C2L-Y-A entrega paquetes de audio AAC encapsulados con cabecera ADTS de 7 bytes (`0xFFF1...`) en el canal interleaved RTP (Payload Type 104) dentro del protocolo propietario EseeCloud HTTP.

### 2.2 Limitación de `go2rtc` v1.9.15 Original
En su implementación original (`pkg/eseecloud/eseecloud.go`), `go2rtc` solo procesaba paquetes con firma `"G711"` e ignoraba silenciosamente la firma `"AAC"`. En consecuencia, el servidor RTSP y el reproductor MSE/WebRTC no exponían ninguna pista de audio.

### 2.3 Solución Aplicada (`patches/eseecloud_aac.patch`)
Se desarrolló y compiló un parche para `go2rtc` que:
1. Registra el códec `core.CodecAAC` a 8000 Hz mono (`FmtpLine: aac.FMTP + "1588"`, `PayloadTypeRAW`).
2. En tiempo de ejecución (`Start()`), extrae la cabecera ADTS (`aac.ADTSHeaderLen`) y reempaqueta cada Access Unit (AU) con `aac.RTPPacketVersionAAC = 0` para permitir que el consumidor RTSP invoque `aac.RTPPay` (RFC 3640).
3. **Compatibilidad WebRTC:** Como los navegadores web modernos no admiten códec AAC en sesiones WebRTC nativas, se configuró una fuente secundaria transcodificada en `go2rtc.yaml`:
   ```yaml
   streams:
     c2l_hd:
       - eseecloud://admin:@192.168.1.40:80/livestream/11
       - ffmpeg:c2l_hd#video=copy#audio=opus
   ```
4. **Grabador NVR:** La tubería continua de grabación FFmpeg utiliza `-c copy`, preservando el stream original de video H.264 y el stream original de audio AAC sin re-codificación ni pérdida de sincronización ni consumo de CPU.

---

## 3. Control PTZ (`ptzctrl.cgi`) y Presets (`preset.cgi`)

### 3.1 Control PTZ
- **URL:** `GET http://192.168.1.40/cgi-bin/hi3510/ptzctrl.cgi?-step=[0|1]&-act=[ACCION]&-speed=[1-8]`
- **Respuesta válida:** `[Success] ptz ok` (HTTP 200)
- **Acciones soportadas:** `up`, `down`, `left`, `right`, `stop`, `zoomin`, `zoomout`, `focusin`, `focusout`, `auto`, `cruisestop`.

### 3.2 Presets
- **URL:** `GET http://192.168.1.40/cgi-bin/hi3510/preset.cgi?-status=1&-act=[goto|set]&-number=[1-8]`
- **Respuesta:** `[Success] preset ok` (HTTP 200).

---

## 4. Estado de Luz y Modo Día/Noche (Inferencia Analítica)

### 4.1 Naturaleza del Control de "Luz"
La cámara **no dispone de luz blanca ni linterna auxiliar**. Su opción de "Luz" en la app móvil conmuta el modo Día/Noche:
- **Luz ON:** Modo DÍA (color forzado, filtro IR-Cut mecánico activo sobre el sensor, LEDs infrarrojos apagados).
- **Luz OFF:** Modo NOCHE (blanco y negro, filtro IR-Cut retirado, LEDs infrarrojos de 850nm encendidos).

### 4.2 Evidencia Experimental
- `preset.cgi?-act=goto&-number=64` / `65` responde `[Success] ptz ok` pero **no acciona físicamente nada** (el firmware lo trata como un preset PTZ de movimiento sin coordenadas).
- Todos los comandos CGI de parámetros de luz (`getlightattr`, `getinfraredstat`, `getlampattr`, `getircutattr`) responden `HTTP 403 Forbidden`.
- La app móvil conmuta el modo mediante sockets propietarios P2P (puerto 10000 o nube de EseeCloud), fuera del alcance de la API HTTP local.

### 4.3 Inferencia en el NVR (`/api/daynight`)
El NVR infiere el estado físico a partir de `/snapshot.jpg`:
1. Decodificación de fotograma a 64x36 en RGB24 vía FFmpeg (~8ms).
2. Cálculo de la saturación media HSV ($S = \frac{\max(R,G,B) - \min(R,G,B)}{\max(R,G,B)}$).
3. **Histéresis:**
   - Saturación $> 5.0\% \implies \text{Día (Color)}$
   - Saturación $\le 1.0\% \implies \text{Noche (Infrarrojo)}$
   - Entre $1.0\%$ y $5.0\% \implies$ Mantiene el estado anterior.
4. **Filtro de Descarte (Debounce):** Requiere $N=2$ lecturas consecutivas para confirmar la transición de estado.
5. **Supresión de Falsos Eventos de Movimiento:**
   - Al conmutar el filtro IR-cut, la cámara produce un destello que altera abruptamente los píxeles.
   - El NVR activa automáticamente una ventana de gracia de `DAYNIGHT_SWITCH_GRACE_S=8` segundos en el motor de movimiento, resetea el fotograma de referencia (`previousFrame = null`) y aborta cualquier falso evento desencadenado por el cambio.
6. **Endpoints de API:**
   - `GET /api/daynight`: Retorna `{ state: "day"|"night"|"unknown", source: "inferred", saturation, brightness, updatedAt }`.
   - `POST /api/daynight` y `POST /api/light`: Retornan `HTTP 501 Not Implemented` con mensaje aclaratorio de que la conmutación física requiere la app móvil.

---

## 5. Diseño de Interfaz y OSD Nativo de la Cámara

El firmware de la cámara estampa de forma indeleble un OSD en la franja superior del video (~0-11% de la altura):
- **Superior Izquierda:** Nombre de la cámara.
- **Superior Derecha:** Fecha y hora sincronizadas.

Para evitar obstrucciones:
1. **Área Protegida:** La franja superior del reproductor web no contiene ningún elemento flotante ni badge.
2. **Barra de Estado Externa:** Todos los indicadores de estado (calidad, latencia, modo de reproducción, chip de día/noche, estado del grabador) se ubican en una barra dedicada debajo del reproductor.
3. **Alerta de Movimiento:** Se sitúa de forma no intrusiva en la esquina inferior izquierda.
4. **Indicadores HUD Opcionales:** Se ubican en la esquina inferior derecha y pueden alternarse mediante el botón `👁️ HUD ON/OFF` (preferencia persistida en `localStorage`).
