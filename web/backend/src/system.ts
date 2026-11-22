import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { addLog } from './logger.js';
import { getRecorderManager } from './recorder-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execAsync = promisify(exec);

export interface HealthStatus {
  status: 'ok' | 'degraded' | 'error';
  timestamp: string;
  camera: {
    online: boolean;
    host: string;
    responseTimeMs?: number;
  };
  go2rtc: {
    online: boolean;
    url: string;
    streams?: Record<string, any>;
  };
  recorder: {
    active: boolean;
    mode?: string;
    lastSegmentRecorded?: string;
  };
}

export async function checkSystemHealth(): Promise<HealthStatus> {
  const t0 = Date.now();
  let cameraOnline = false;
  let cameraRespTime = 0;

  // Check camera snapshot
  try {
    const authStr = `${config.CAMERA_USER}:${config.CAMERA_PASS}`;
    const b64Auth = Buffer.from(authStr, 'utf8').toString('base64');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);

    const res = await fetch(`http://${config.CAMERA_HOST}:${config.CAMERA_PORT}/snapshot.jpg`, {
      method: 'GET',
      headers: { 'Authorization': `Basic ${b64Auth}` },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    cameraRespTime = Date.now() - t0;
    cameraOnline = res.ok;
  } catch {
    cameraOnline = false;
  }

  // Check go2rtc
  let go2rtcOnline = false;
  let streamsData: any = null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`${config.GO2RTC_URL}/api/streams`, { signal: controller.signal });
    clearTimeout(timeout);
    if (res.ok) {
      go2rtcOnline = true;
      streamsData = await res.json();
    }
  } catch {
    go2rtcOnline = false;
  }

  const recStatus = getRecorderManager().getStatus();
  const recorderActive = recStatus.active;

  const overall = (cameraOnline && go2rtcOnline && recorderActive) ? 'ok'
    : (cameraOnline && go2rtcOnline) ? 'degraded' : 'error';

  return {
    status: overall,
    timestamp: new Date().toISOString(),
    camera: {
      online: cameraOnline,
      host: config.CAMERA_HOST,
      responseTimeMs: cameraRespTime,
    },
    go2rtc: {
      online: go2rtcOnline,
      url: config.GO2RTC_URL,
      streams: streamsData,
    },
    recorder: {
      active: recorderActive,
      mode: recStatus.mode,
    },
  };
}

export async function getLiveSnapshotBuffer(): Promise<{ buffer: Buffer; contentType: string }> {
  const authStr = `${config.CAMERA_USER}:${config.CAMERA_PASS}`;
  const b64Auth = Buffer.from(authStr, 'utf8').toString('base64');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);

  const res = await fetch(`http://${config.CAMERA_HOST}:${config.CAMERA_PORT}/snapshot.jpg`, {
    method: 'GET',
    headers: { 'Authorization': `Basic ${b64Auth}` },
    signal: controller.signal,
  });
  clearTimeout(timeout);

  if (!res.ok) {
    throw new Error(`Camera returned HTTP ${res.status}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    contentType: res.headers.get('content-type') || 'image/jpeg',
  };
}

export async function startRecorder(): Promise<{ success: boolean; message: string; active: boolean }> {
  try {
    const mgr = getRecorderManager();
    const status = await mgr.setMode('continuous');
    return {
      success: true,
      message: 'Grabación iniciada correctamente',
      active: status.active,
    };
  } catch (err: any) {
    addLog('error', `Error al iniciar el grabador: ${err.message}`);
    return { success: false, message: err.message, active: false };
  }
}

export async function stopRecorder(): Promise<{ success: boolean; message: string; active: boolean }> {
  try {
    const mgr = getRecorderManager();
    await mgr.setMode('paused');
    return {
      success: true,
      message: 'Grabación detenida correctamente',
      active: false,
    };
  } catch (err: any) {
    addLog('error', `Error al detener el grabador: ${err.message}`);
    return { success: false, message: err.message, active: false };
  }
}

export async function updateCameraConfig(
  newHost: string,
  newPort: number = 80,
  newRecDir?: string,
  newRetention?: number
): Promise<{ success: boolean; message: string }> {
  try {
    config.CAMERA_HOST = newHost;
    config.CAMERA_PORT = newPort;
    if (newRecDir) config.RECORDINGS_DIR = newRecDir;
    if (newRetention) config.RETENTION_DAYS = newRetention;

    // 1. Update .env if present
    const possibleEnv = [
      '/home/chkdsk/c2l_nvr/.env',
      path.resolve(process.cwd(), '.env'),
      path.resolve(__dirname, '../../../../.env'),
      '/app/.env',
    ].find((p) => fs.existsSync(p));

    if (possibleEnv) {
      try {
        let content = fs.readFileSync(possibleEnv, 'utf8');
        content = content.replace(/^CAMERA_HOST=.*/m, `CAMERA_HOST=${newHost}`);
        content = content.replace(/^CAMERA_PORT=.*/m, `CAMERA_PORT=${newPort}`);
        if (newRecDir) content = content.replace(/^RECORDINGS_DIR=.*/m, `RECORDINGS_DIR=${newRecDir}`);
        if (newRetention) content = content.replace(/^RETENTION_DAYS=.*/m, `RETENTION_DAYS=${newRetention}`);
        fs.writeFileSync(possibleEnv, content, 'utf8');
      } catch {}
    }

    // 2. Generate updated go2rtc.yaml
    const auth = config.CAMERA_USER ? `${config.CAMERA_USER}:${config.CAMERA_PASS}@` : '';
    const go2rtcYaml = `streams:
  c2l_hd: eseecloud://${auth}${newHost}:${newPort}/livestream/11
  c2l_sd: eseecloud://${auth}${newHost}:${newPort}/livestream/12

api:
  listen: ":1984"
  origin: "*"

webrtc:
  listen: ":8555"

rtsp:
  listen: ":8554"

log:
  level: info
`;

    const yamlPaths = ['/home/chkdsk/go2rtc.yaml', '/home/chkdsk/c2l_nvr/go2rtc.yaml', '/app/go2rtc.yaml'];
    for (const yp of yamlPaths) {
      try {
        fs.writeFileSync(yp, go2rtcYaml, 'utf8');
      } catch {}
    }

    // 3. Restart go2rtc and recorder
    addLog('warn', `Reconfigurando cámara IP a: ${newHost}:${newPort}...`);
    await stopRecorder();
    await execAsync("pkill -f '[g]o2rtc' || true").catch(() => {});
    await new Promise((r) => setTimeout(r, 1000));

    const go2rtcBin = fs.existsSync('/usr/local/bin/go2rtc')
      ? '/usr/local/bin/go2rtc'
      : fs.existsSync('/home/chkdsk/bin/go2rtc')
      ? '/home/chkdsk/bin/go2rtc'
      : 'go2rtc';

    const activeYaml = yamlPaths.find((p) => fs.existsSync(p)) || '/app/go2rtc.yaml';
    if (fs.existsSync(go2rtcBin) || go2rtcBin === 'go2rtc') {
      const child = spawn(go2rtcBin, ['-c', activeYaml], { detached: true, stdio: 'ignore' });
      child.unref();
    }

    await new Promise((r) => setTimeout(r, 1500));
    await startRecorder();

    addLog('info', `Cámara reconectada exitosamente en ${newHost}:${newPort}`);
    return { success: true, message: `Configuración aplicada. Conectando a ${newHost}:${newPort}` };
  } catch (err: any) {
    addLog('error', `Error al actualizar configuración: ${err.message}`);
    return { success: false, message: err.message };
  }
}
