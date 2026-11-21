# C2L NVR Suite - Sistema de Videovigilancia y Grabación 24/7
**Plataforma Full-Stack Local para Cámara IP PTZ EseeCloud C2L-Y-A**

---

## 1. Resumen y Arquitectura

Este sistema transforma una cámara doméstica **EseeCloud C2L-Y-A** (192.168.1.40) —cuyo firmware viene con el puerto 554 cerrado de fábrica para forzar el uso de la app móvil— en un sistema NVR local profesional, autónomo, seguro y con interfaz web moderna en **Angular 19** y **Node.js / TypeScript**.

```
                           RED LOCAL (LAN)
                      ┌────────────────────────┐
                      │  Cámara C2L-Y-A PTZ    │
                      │     192.168.1.40       │
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
           RTSP (-c copy)    │           │ WebRTC / MSE
                             ▼           ▼
┌──────────────────────────────┐       ┌────────────────────────────────┐
│   FFmpeg 24/7 Recorder       │       │    Fastify Backend (Node.js)   │
│   Segmentos de 15 min        │       │    API REST, Auth, PTZ Proxy,  │
│   recordings/YYYY-MM-DD/     │       │    Range Streaming (206)       │
└──────────────────────────────┘       └───────────────┬────────────────┘
                                                       │
                                                       ▼
                                       ┌────────────────────────────────┐
                                       │    Angular 19 Frontend         │
                                       │    SPA Dark Theme, Signals,    │
                                       │    D-pad PTZ, Timeline 24h     │
                                       │    http://localhost:8000       │
                                       └────────────────────────────────┘
```

---

## 2. Acceso y URLs de Streaming

- **Panel Web NVR:** [http://localhost:8000](http://localhost:8000)
  - Usuario por defecto: `admin`
  - Contraseña por defecto: `admin123` *(configurable en `.env`)*
- **Stream en VLC (Red Local):**
  - Stream HD (720p 15fps): `rtsp://localhost:8554/c2l_hd`
  - Stream SD (360p 15fps): `rtsp://localhost:8554/c2l_sd`
  - Parámetros VLC recomendados: `:network-caching=300 :rtsp-tcp`
- **go2rtc Web UI:** [http://localhost:1984](http://localhost:1984)

---

## 3. Control de Servicios

El sistema incluye el script unificado de control `ctl.sh`:

```bash
cd /home/chkdsk/c2l_nvr

# Ver estado de salud de todos los componentes
./ctl.sh status

# Iniciar todos los componentes (go2rtc, grabador FFmpeg, servidor Web)
./ctl.sh start

# Detener los servicios
./ctl.sh stop

# Instalar y habilitar servicios systemd para arranque automático con el sistema
./ctl.sh install-systemd
```

### Gestión con Systemd (Nivel Usuario, sin root)

Los servicios se encuentran en `~/.config/systemd/user/`:
- `systemctl --user status c2l-go2rtc.service`
- `systemctl --user status c2l-recorder.service`
- `systemctl --user status c2l-web.service`

Para reiniciar cualquiera de ellos:
```bash
systemctl --user restart c2l-web
```

---

## 4. Desarrollo y Compilación (NPM)

Dentro de `/home/chkdsk/c2l_nvr/web/`:

```bash
# Compilar frontend y backend
npm run build

# Iniciar servidor backend en producción (sirve el frontend en :8000)
npm run start

# Desarrollo:
npm run dev:backend   # Levanta Fastify con recarga en caliente (tsx watch)
npm run dev:frontend  # Levanta Angular en :4200 con proxy a :8000

# Ejecutar tests de validación y seguridad
npm run test
```

---

## 5. Tabla de la API REST

Todas las rutas `/api/*` (excepto `/api/auth/login` y `/api/health`) requieren cookie de sesión `nvr_token` (HttpOnly).

| Método | Ruta | Parámetros / Body | Descripción |
|---|---|---|---|
| `GET` | `/api/health` | - | Healthcheck: estado de cámara, go2rtc y grabador |
| `POST` | `/api/auth/login` | `{ username, password }` | Login y emisión de cookie HttpOnly JWT |
| `POST` | `/api/auth/logout` | - | Cierre de sesión y limpieza de cookie |
| `GET` | `/api/auth/me` | - | Validar sesión de usuario |
| `POST` | `/api/ptz/move` | `{ action: "up"\|"down"\|"left"\|"right"\|"zoomin"\|"zoomout"\|"stop", step: 0\|1, speed: 1-8 }` | Movimiento PTZ con validación estricta y rate-limit |
| `POST` | `/api/ptz/preset` | `{ action: "goto"\|"set", number: 1-8, name?: string }` | Ir o guardar preset (persiste nombres en JSON local) |
| `GET` | `/api/ptz/presets` | - | Lista de presets configurados con nombres |
| `GET` | `/api/snapshot` | - | Proxy autenticado para descargar JPEG actual |
| `GET` | `/api/recordings` | `?date=YYYY-MM-DD` | Lista días disponibles o segmentos de un día |
| `GET` | `/api/recordings/:date/:file` | Cabecera `Range: bytes=...` | Stream HTTP 206 de video MP4 con protección path traversal |
| `GET` | `/api/recordings/:date/:file/thumb` | - | Entrega miniatura generada con FFmpeg en caché |
| `POST` | `/api/recordings/clip` | `{ date, file, startSeconds, durationSeconds }` | Exporta clip con `ffmpeg -ss -to -c copy` sin recodificar |
| `GET` | `/api/clips/:file` | - | Descarga de clip exportado |
| `DELETE`| `/api/recordings/:date/:file` | - | Borrado manual de segmento |
| `GET` | `/api/storage` | - | Métricas de disco (usado, libre, consumo/día, retención) |
| `POST` | `/api/retention/run` | - | Ejecución manual de ciclo de purga de grabaciones |
| `GET` | `/api/logs` | `?limit=50` | Registro de eventos del sistema (errores, purgas, caídas) |

---

## 6. Variables de Entorno (`.env`)

Ubicación: `/home/chkdsk/c2l_nvr/.env`

```ini
# Configuración de Cámara
CAMERA_HOST=192.168.1.40
CAMERA_PORT=80
CAMERA_USER=admin
CAMERA_PASS=

# go2rtc Streaming Bridge
GO2RTC_URL=http://127.0.0.1:1984
GO2RTC_RTSP=rtsp://127.0.0.1:8554

# Almacenamiento y Grabaciones
RECORDINGS_DIR=/home/chkdsk/c2l_nvr/recordings
THUMBS_DIR=/home/chkdsk/c2l_nvr/cache/thumbs
DATA_DIR=/home/chkdsk/c2l_nvr/data
SEGMENT_SECONDS=900
RETENTION_DAYS=7
MAX_DISK_USAGE_PERCENT=90

# Servidor Web y Seguridad
PORT=8000
AUTH_USER=admin
AUTH_PASS_HASH=$2a$10$r2JgGUv9lK7rxZ24sP2cKeQJi1s18b8oLB/UD8D08SNSihPFADscu
JWT_SECRET=super_secret_jwt_c2l_nvr_key_2026_xyz987

# Rutas de Binarios
FFMPEG_PATH=/home/chkdsk/bin/ffmpeg
FFPROBE_PATH=/home/chkdsk/bin/ffprobe
```

---

## 7. Políticas de Grabación y Retención

- **Modo de Grabación:** Copia directa (`-c copy`) en contenedor MP4 (`+faststart`). Cero consumo de CPU por recodificación.
- **Segmentación:** Segmentos automáticos de 15 minutos (900 segundos) nombrados cronológicamente:
  `recordings/YYYY-MM-DD/c2l_YYYYMMDD_HHMMSS.mp4`
- **Consumo Real Medido:**
  - Bitrate medio: ~300 kbps (40 KB/s).
  - Consumo diario: **~3.24 GB / día**.
  - Almacenamiento estimado para 7 días: **~22.7 GB** (el disco cuenta con más de 900 GB libres).
- **Retención Automática:**
  - El backend ejecuta una verificación de retención al arrancar y cada 60 minutos.
  - Elimina grabaciones con antigüedad mayor a `RETENTION_DAYS` (7 días).
  - Si el disco supera el `MAX_DISK_USAGE_PERCENT` (90%), purga los archivos más antiguos hasta restablecer un margen de seguridad.
  - Las carpetas de fechas vacías son removidas automáticamente.

---

## 8. Funcionalidades de la Interfaz Web (Angular 19)

1. **Panel En Vivo:**
   - Reproductor WebRTC ultra baja latencia (<300 ms).
   - Selector HD (720p) / SD (360p).
   - Botón de instantánea ("Snapshot") para guardar la imagen actual en JPEG.
   - Modo de pantalla completa.
2. **Control PTZ:**
   - D-pad direccional (Arriba, Abajo, Izquierda, Derecha, Stop central, Zoom In / Zoom Out).
   - Control continuo con soporte para mantener presionado (mouse, touch y teclado mediante flechas `↑`, `↓`, `←`, `→`).
   - Selector de velocidad (1 a 8).
   - 8 Presets rápidos memorizables: clic para ir a posición, botón guardar para memorizar la posición actual y asignarle un nombre descriptivo.
3. **Explorador de Grabaciones:**
   - Selector de días con conteo de clips y tamaño acumulado.
   - Miniaturas generadas automáticamente mediante FFmpeg cacheadas fuera de la carpeta de grabaciones.
   - Detección del segmento activo en grabación ("🔴 Grabando..."), bloqueado preventivamente para evitar reproducir archivos con `moov atom` abierto.
   - Reproductor de video HTML5 compatible con solicitudes `Range: bytes` (permite adelantar y retroceder sin esperar a descargar el archivo completo).
   - Atajos de teclado: `Espacio` (Play/Pausa), `←` / `→` (Seek ±10s), selector de velocidad (0.5x, 1x, 1.5x, 2x, 4x).
   - Reproducción continua: salta automáticamente al siguiente segmento al finalizar el actual.
   - Herramienta para recortar y descargar clips (`.mp4`) por rango de tiempo sin recodificar.
4. **Panel de Sistema:**
   - Barra de estado de capacidad de almacenamiento en tiempo real.
   - Botón de purga manual inmediata.
   - Tabla interactiva con el registro histórico de logs (errores, caídas de cámara, limpiezas).

---

## 9. Recomendaciones Críticas de Seguridad

> [!WARNING]
> 1. **Cambiar la contraseña de la cámara:** Actualmente el usuario `admin` tiene contraseña vacía por defecto. Se recomienda ingresar a la app móvil de EseeCloud y configurar una contraseña segura de dispositivo. Una vez cambiada, actualiza `CAMERA_PASS` en `/home/chkdsk/c2l_nvr/.env`.
> 2. **Aislamiento en VLAN:** Es buena práctica colocar la cámara IP en una VLAN de dispositivos IoT aislada de la red principal de computadores personales, sin salida directa a internet.
> 3. **Acceso Remoto:** NUNCA abras puertos en tu router (port forwarding) hacia este NVR ni hacia la cámara. Si necesitas consultar el video o las grabaciones fuera de casa, utiliza una VPN segura como **Tailscale** o **WireGuard**.
