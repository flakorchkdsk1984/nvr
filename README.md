# C2L NVR Suite - Sistema de Videovigilancia y Grabación 24/7
**Plataforma Full-Stack Local y en Docker para Cámaras IP PTZ EseeCloud C2L-Y-A (y compatibles Hi3510 / Xiongmai)**

[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)
[![Angular](https://img.shields.io/badge/Angular-19_Standalone-DD0031?logo=angular&logoColor=white)](https://angular.dev/)
[![NodeJS](https://img.shields.io/badge/Node.js-Fastify_TypeScript-339933?logo=node.js&logoColor=white)](https://fastify.dev/)
[![go2rtc](https://img.shields.io/badge/go2rtc-RTSP_WebRTC_MSE-blue)](https://github.com/AlexxIT/go2rtc)
[![FFmpeg](https://img.shields.io/badge/FFmpeg-24%2F7_Direct_Copy-green?logo=ffmpeg&logoColor=white)](https://ffmpeg.org/)

---

## 1. Resumen y Arquitectura

Este sistema transforma una cámara doméstica **EseeCloud C2L-Y-A** (o cualquier cámara con firmware HiSilicon Hi3510 / protocolo `eseecloud://` por puerto 80) en un sistema NVR local profesional, autónomo, seguro y con interfaz web moderna en **Angular 19** y **Node.js / TypeScript**.

```
                           RED LOCAL (LAN)
                      ┌────────────────────────┐
                      │  Cámara C2L-Y-A PTZ    │
                      │   (IP configurable)    │
                      └──────────┬─────────────┘
                                 │ HTTP (SDP + RTP interleaved /livestream/11)
                                 │ HTTP CGI (/cgi-bin/hi3510/ptzctrl.cgi)
                                 ▼
                     ┌───────────────────────────┐
                     │          go2rtc           │
                     │  (Puente de streaming)    │
                     │  RTSP: :8554 | Web: :1984 │
                     └───────┬───────────┬───────┘
                             │           │
           RTSP (-c copy)    │           │ MSE / HLS / WebSocket
                             ▼           ▼
┌──────────────────────────────┐       ┌────────────────────────────────┐
│   FFmpeg 24/7 Recorder       │       │    Fastify Backend (Node.js)   │
│   Segmentos de 15 min        │       │    API REST, Auth JWT,         │
│   recordings/YYYY-MM-DD/     │       │    PTZ Proxy, Range (206)      │
└──────────────────────────────┘       └───────────────┬────────────────┘
                                                       │
                                                       ▼
                                       ┌────────────────────────────────┐
                                       │    Angular 19 Frontend         │
                                       │    SPA Dark Theme, Signals,    │
                                       │    D-pad PTZ, Timeline 24h     │
                                       │    http://localhost:8080       │
                                       └────────────────────────────────┘
```

---

## 2. Despliegue con Docker y Docker Compose (Recomendado)

El proyecto viene completamente empaquetado para correr en un único contenedor o mediante `docker compose`.

### 2.1. Inicio Rápido

```bash
# 1. Clonar el repositorio
git clone https://github.com/flakorchkdsk1984/nvr.git
cd nvr

# 2. Iniciar el servicio con Docker Compose
docker compose up -d --build

# 3. Ver logs en tiempo real
docker compose logs -f
```

Una vez iniciado, accede al panel en tu navegador:
👉 **[http://localhost:8080](http://localhost:8080)**  
*(Credenciales por defecto: Usuario: `admin` | Contraseña: `admin123`)*

---

### 2.2. ¿Cómo Cambiar la IP de la Cámara?

Tienes **3 opciones sencillas**:

#### Opción A: Desde el archivo `docker-compose.yml` (o `.env`)
Edita la variable `CAMERA_HOST` con la IP de tu cámara:

```yaml
services:
  c2l-nvr:
    environment:
      - CAMERA_HOST=192.168.1.50   # <-- Cambia aquí la IP de tu cámara
      - CAMERA_PORT=80
      - CAMERA_USER=admin
      - CAMERA_PASS=
```
Luego reinicia con:
```bash
docker compose up -d
```

#### Opción B: Directamente desde el Panel Web (Sin reiniciar)
1. Ingresa a [http://localhost:8080](http://localhost:8080) con tu usuario y contraseña.
2. Ve a la pestaña **⚙️ Sistema**.
3. En la tarjeta **"Configuración de Cámara IP y Grabaciones"**, escribe la nueva dirección IP y puerto.
4. Haz clic en **"💾 Guardar y Aplicar Cambios"**. El NVR reconfigurará `go2rtc` y reiniciará el grabador automáticamente con la nueva IP.

#### Opción C: Ejecutando directamente con `docker run`
```bash
docker run -d \
  --name c2l_nvr \
  --net=host \
  --restart=unless-stopped \
  -e CAMERA_HOST=192.168.1.50 \
  -e CAMERA_PORT=80 \
  -v /mi/disco/grabaciones:/app/recordings \
  -v /mi/disco/datos:/app/data \
  c2l-nvr
```

---

### 2.3. ¿Cómo Cambiar el Lugar Donde se Guardan los Videos (Records)?

En el archivo `docker-compose.yml`, localiza la sección `volumes` y modifica la ruta a la izquierda de los dos puntos (`:`):

```yaml
    volumes:
      # Ruta en tu PC o Servidor (Host) : Ruta dentro del Contenedor
      - /mnt/disco_externo/mis_grabaciones:/app/recordings   # <-- Cambia aquí tu disco o carpeta
      - ./data:/app/data
      - ./cache:/app/cache
```

**Ejemplos según tu sistema operativo:**
- **Linux / Servidor NVR:** `- /mnt/disco_secundario/nvr_recordings:/app/recordings`
- **Windows (Docker Desktop):** `- D:/Videovigilancia/Recordings:/app/recordings`
- **Carpeta relativa local:** `- ./recordings:/app/recordings`

---

## 3. Acceso y URLs del Sistema

| Servicio | URL / Dirección | Descripción |
|---|---|---|
| **Panel Web NVR** | [http://localhost:8080](http://localhost:8080) | Panel de control completo (En Vivo, Grabaciones, PTZ, Sistema) |
| **Stream HD (VLC)** | `rtsp://localhost:8554/c2l_hd` | Stream principal 1280x720 H.264 @ 15fps + Audio AAC |
| **Stream SD (VLC)** | `rtsp://localhost:8554/c2l_sd` | Sub-stream 640x360 H.264 @ 15fps |
| **go2rtc Web UI** | [http://localhost:1984](http://localhost:1984) | Monitor interno de streams y depuración WebRTC |
| **Instantánea JPEG** | `http://localhost:8080/api/snapshot` | Captura JPEG actual con autenticación |

> [!TIP]
> **Ajustes óptimos para VLC:** Al abrir la URL RTSP en VLC (**Medios > Abrir ubicación de red**), marca "Mostrar más opciones" y añade `:network-caching=300 :rtsp-tcp` para eliminar latencia y microcortes.

---

## 4. Funcionalidades Principales

### 📡 4.1. Panel en Vivo
- **Motor de Video Nativo (HTML5 / Angular Signals):**
  - **MSE Fluido (TCP por WebSocket):** Reproducción continua en Ultra Baja Latencia (~200–300 ms). Incluye gestión de buffer histórica que elimina completamente el congelamiento de imagen y las restricciones NAT de WSL2/WebRTC.
  - **HLS:** Streaming estándar HTTP por segmentos vía `hls.js`.
  - **Snapshot (1s):** Modo de refresco continuo por capturas JPEG para conexiones lentas.
- **Selector de Resolución:** Cambio instantáneo entre **HD (720p)** y **SD (360p)**.
- **HUD con Métricas en Tiempo Real:** Indicador `EN VIVO`, resolución actual y latencia calculada dinámicamente.
- **Captura Instantánea:** Botón para descargar de inmediato un JPEG de alta calidad con timestamp.
- **Pantalla Completa:** Visualización inmersiva en monitor o televisor.

### 🔴 4.2. Control de Grabación Continua 24/7
- **Botón de Iniciar / Detener Grabación:** Ubicado directamente en la cabecera superior y en la barra de herramientas de video.
- Permite pausar y reanudar la grabación continua sin detener el servidor ni perder la vista en vivo.
- El proceso envía señales `SIGTERM` seguras a FFmpeg para cerrar el contenedor MP4 sin corromper el último segmento.

### 🎮 4.3. Control PTZ y Presets
- **D-pad Interactivo:** Mover Arriba, Abajo, Izquierda, Derecha y Parar (botón central).
- **Atajos de Teclado:** Usa las teclas de flechas (↑ ↓ ← →) y la barra espaciadora para mover y detener la cámara mientras ves el video.
- **Modo Continuo vs Paso a Paso:** Alternador para mover paso a paso o mantener presionado con throttle automático (~200 ms).
- **Control de Velocidad:** Control deslizante de velocidad del motor (niveles 1 a 8).
- **Presets de Posición (1 al 8):**
  - Clic simple: La cámara rota automáticamente a la posición guardada.
  - Clic en el lápiz / editar: Guarda la posición actual de la cámara y permite asignar un nombre personalizado (ej. "Entrada", "Patio", "Vehículo"). Los nombres se guardan localmente en `/app/data/presets.json`.

### 📼 4.4. Explorador y Reproductor de Grabaciones
- **Indexación Automática:** Escaneo inteligente de carpetas por fecha (`recordings/YYYY-MM-DD/c2l_YYYYMMDD_HHMMSS.mp4`).
- **Miniaturas (Thumbnails):** Miniaturas generadas automáticamente mediante FFmpeg y cacheadas en disco.
- **Streaming HTTP 206 (Partial Content):** Reproductor nativo HTML5 con soporte de peticiones `Range`, permitiendo saltar a cualquier segundo del video al instante sin descargar el archivo completo.
- **Velocidad de Reproducción Variable:** Selector de velocidad (0.5x, 1x, 1.5x, 2x, 4x).
- **Reproducción Continua (Auto-Next):** Al finalizar un segmento de 15 minutos, el reproductor avanza automáticamente al segmento siguiente.
- **Exportador de Clips:** Modal integrado para recortar un fragmento de video específico (`Inicio` y `Duración`) y descargarlo al instante sin recodificar (`-c copy`).
- **Eliminación Manual:** Botón para eliminar grabaciones obsoletas individualmente.

### ⚙️ 4.5. Sistema, Almacenamiento y Retención Automática
- **Métricas de Disco:** Porcentaje de uso del disco, gigabytes libres, peso total acumulado y consumo medio por día.
- **Retención Automática Configurable:** El sistema ejecuta un ciclo cada 60 minutos purgando archivos más antiguos que `RETENTION_DAYS` (por defecto 7 días), o si el disco supera el 90% de capacidad.
- **Purga Manual:** Botón para forzar la limpieza de retención en cualquier momento.
- **Visor de Eventos (Logs):** Registro en vivo de inicios de sesión, movimientos PTZ, purgas de disco y errores.

---

## 5. Instalación y Uso Nativo (Sin Docker)

Si prefieres ejecutar el sistema directamente en tu máquina (Linux / WSL2):

### 5.1. Control con `ctl.sh`
```bash
# Iniciar todos los servicios (go2rtc + grabador + web)
./ctl.sh start

# Ver estado y procesos activos
./ctl.sh status

# Detener los servicios
./ctl.sh stop

# Ver logs
./ctl.sh logs
```

### 5.2. Instalación como Servicios de Usuario en Systemd
```bash
./ctl.sh install-systemd
systemctl --user start c2l-go2rtc c2l-recorder c2l-web
systemctl --user status c2l-web
```

---

## 6. Referencia de la API REST

Todos los endpoints (excepto `/api/health` y `/api/auth/login`) requieren autenticación mediante cookie HTTP-Only JWT.

| Método | Endpoint | Parámetros / Body | Descripción |
|---|---|---|---|
| `GET` | `/api/health` | - | Estado de la cámara, go2rtc y grabador |
| `POST` | `/api/auth/login` | `{ username, password }` | Inicio de sesión (genera cookie segura JWT) |
| `POST` | `/api/auth/logout` | - | Cierre de sesión y limpieza de cookie |
| `GET` | `/api/auth/me` | - | Validar sesión de usuario |
| `POST` | `/api/recorder/start` | - | Inicia el servicio de grabación continua 24/7 |
| `POST` | `/api/recorder/stop` | - | Detiene el servicio de grabación continua 24/7 |
| `GET` | `/api/config` | - | Consulta la IP de la cámara y rutas configuradas |
| `POST` | `/api/config` | `{ cameraHost, cameraPort, recordingsDir?, retentionDays? }` | Actualiza la IP de la cámara o almacenamiento en caliente |
| `POST` | `/api/ptz/move` | `{ action, step, speed }` | Movimiento PTZ (`up`, `down`, `left`, `right`, `zoomin`, `zoomout`, `stop`) |
| `POST` | `/api/ptz/preset` | `{ action: "goto"\|"set", number: 1-8, name? }` | Ejecutar o memorizar posición de preset |
| `GET` | `/api/ptz/presets` | - | Lista de presets memorizados con nombres |
| `GET` | `/api/snapshot` | - | Captura JPEG actual directamente desde la cámara |
| `GET` | `/api/recordings` | `?date=YYYY-MM-DD` | Lista de días o segmentos grabados |
| `GET` | `/api/recordings/:date/:file` | Cabecera `Range: bytes=...` | Streaming HTTP 206 de grabaciones MP4 |
| `GET` | `/api/recordings/:date/:file/thumb` | - | Miniatura generada con FFmpeg |
| `POST` | `/api/recordings/clip` | `{ date, file, startSeconds, durationSeconds }` | Recorta y exporta un clip en MP4 |
| `GET` | `/api/clips/:file` | - | Descarga del clip exportado |
| `DELETE`| `/api/recordings/:date/:file` | - | Borrado manual de segmento |
| `GET` | `/api/storage` | - | Métricas de almacenamiento en disco |
| `POST` | `/api/retention/run` | - | Ejecución manual del ciclo de retención |
| `GET` | `/api/logs` | `?limit=50` | Registro de eventos del sistema |

---

## 7. Políticas de Grabación y Retención

- **Modo de Grabación:** Copia directa (`-c copy`) en contenedor MP4 (`-movflags +faststart`). **Cero consumo de CPU por recodificación**.
- **Segmentación:** Segmentos automáticos de 15 minutos (900 segundos) nombrados cronológicamente:
  `recordings/YYYY-MM-DD/c2l_YYYYMMDD_HHMMSS.mp4`
- **Consumo Real Medido:**
  - Bitrate medio: ~300 kbps (fluctúa entre 30 y 60 KB/s según movimiento).
  - Espacio por hora: ~135 MB / hora.
  - Espacio por día: **~3.24 GB / día**.
  - **Para 7 días de retención:** Tan solo **~22.7 GB**.

---

## 8. Recomendaciones de Seguridad

> [!WARNING]
> 1. **Contraseña de la cámara:** Actualmente el usuario `admin` de la cámara tiene contraseña vacía por defecto. Se recomienda ingresar a la app móvil de EseeCloud y configurar una contraseña segura de dispositivo, actualizando luego `CAMERA_PASS` en tu archivo `.env` o `docker-compose.yml`.
> 2. **Aislamiento en VLAN:** Es recomendable situar la cámara IP en una subred o VLAN aislada de dispositivos IoT sin salida directa a internet.
> 3. **Acceso Remoto:** NUNCA abras puertos en tu router (port forwarding) hacia este NVR ni hacia la cámara. Si necesitas consultar el video o grabaciones fuera de tu hogar, utiliza una VPN segura como **Tailscale** o **WireGuard**.
