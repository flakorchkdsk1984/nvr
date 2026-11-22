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

### 1.2 Flujo de Video HD (Stream 11)
- **URL:** `GET http://192.168.1.40/livestream/11`
- **Protocolo:** HiSilicon interleaved RTP sobre HTTP (`Transport: RTP/AVP/TCP;unicast;hisiinterleaved=0-1`)
- **Video:** H.264 @ 1280x720 15 fps (bps: 1024 kbps)
- **Audio:** AAC 8000 Hz, 2 canales
- **Consumo:** Consumido por `go2rtc` con la URL `eseecloud://admin:@192.168.1.40:80/livestream/11`.

### 1.3 Flujo de Video SD (Stream 12 - Sub-stream)
- **URL:** `GET http://192.168.1.40/livestream/12`
- **Protocolo:** HiSilicon interleaved RTP sobre HTTP
- **Video:** H.264 @ 640x360 15 fps (bps: 128 kbps)
- **Uso:** Ideal para análisis de movimiento por software (bajo consumo de CPU y memoria).

---

## 2. API de Parámetros (`param.cgi`)

### 2.1 Atributos de Imagen y Modo de Escena
- **URL:** `GET http://192.168.1.40/cgi-bin/hi3510/param.cgi?cmd=getimageattr`
- **Respuesta (JavaScript variables):**
  ```javascript
  var hue="50","50"/"100";
  var brightness="50","50"/"100";
  var saturation="50","50"/"100";
  var contrast="50","50"/"100";
  var scene="auto";
  var flip="off";
  var mirror="off";
  ```
- **Campos:**
  - `scene`: Modo de escena/visión nocturna (`auto`, `indoor`, `outdoor`, `night`, `day`).
  - `brightness`, `contrast`, `hue`, `saturation`: Rango 0-100 (def: 50).
  - `flip`, `mirror`: Orientación de imagen (`on` | `off`).

### 2.2 Atributos del Codificador de Video
- **Canal 1 (HD):** `GET /cgi-bin/hi3510/param.cgi?cmd=getvencattr&-chn=1`
  ```javascript
  var bps_1="1024";
  var fps_1="15";
  var gop_1="150";
  var brmode_1="1";
  var imagegrade_1="5";
  var width_1="1280";
  var height_1="720";
  ```
- **Canal 2 (SD):** `GET /cgi-bin/hi3510/param.cgi?cmd=getvencattr&-chn=2`
  ```javascript
  var bps_2="128";
  var fps_2="15";
  var gop_2="150";
  var brmode_2="1";
  var imagegrade_2="5";
  var width_2="640";
  var height_2="360";
  ```

---

## 3. Control de Movimiento PTZ (`ptzctrl.cgi`)

- **URL:** `GET http://192.168.1.40/cgi-bin/hi3510/ptzctrl.cgi?-step=[0|1]&-act=[ACCION]&-speed=[1-8]`
- **Respuesta válida:** `[Success] ptz ok` (HTTP 200)
- **Respuesta inválida:** Cuerpo vacío (HTTP 200) o HTTP 400 si faltan parámetros.
- **Acciones soportadas por el firmware:**
  - `up`: Mover arriba (Tilt +)
  - `down`: Mover abajo (Tilt -)
  - `left`: Girar izquierda (Pan -)
  - `right`: Girar derecha (Pan +)
  - `stop`: Detener movimiento continuo
  - `zoomin`: Comando zoom in (lente fija en C2L-Y-A, complementado con zoom digital en NVR)
  - `zoomout`: Comando zoom out
  - `focusin`: Comando foco cercano
  - `focusout`: Comando foco lejano
  - `auto`: Modo auto-patrulla / auto-escaneo
  - `cruisestop`: Detener crucero/patrulla

---

## 4. Gestión de Presets (`preset.cgi`)

- **URL:** `GET http://192.168.1.40/cgi-bin/hi3510/preset.cgi?-status=1&-act=[ACCION]&-number=[NUMERO]`
- **Parámetros:**
  - `-act`: `goto` (ir al preset) o `set` (guardar posición actual en el preset).
  - `-number`: Número entero del 1 al 8.
- **Respuesta:** `[Success] preset ok` (HTTP 200).

---

## 5. Estado de Detección de Movimiento y Luz en el Firmware

1. **Detección de Movimiento de la Cámara:**
   - Comandos candidatos probados (`getmdattr`, `getalarmattr`, `getmotiondetectattr`, `getmdstat`, `getalarmstat`, `getevent`): **HTTP 403 Forbidden**.
   - No hay demonio ONVIF abierto (puerto 80 responde 404 a SOAP, puertos 8899/8000/5000 cerrados).
   - El firmware solo envía eventos de movimiento hacia la nube propietaria de EseeCloud/JuanCloud vía socket P2P cifrado.
   - **Solución arquitectónica (Plan B):** Detección de movimiento continua por software en el NVR analizando el sub-stream `c2l_sd` (640x360 @ 2-5 fps) mediante FFmpeg (filtro `select`/`scene` / `scdet`) o decodificación diferencial en Node.js, consumiendo < 3% de CPU.

2. **Control de Luz:**
   - La cámara cuenta con sensor infrarrojo e iluminación IR (o luz blanca inteligente en modelos combinados).
   - El modo de visión nocturna / iluminación se rige por el parámetro `scene` en `param.cgi`:
     - `scene="auto"`: Iluminación automática según fotodiodo/luma.
     - `scene="night"`: Iluminación infrarroja forzada.
     - `scene="indoor"` / `scene="day"`: Iluminación apagada (modo diurno color).
