import path from 'path';
import fs from 'fs';
import { config } from './config.js';
import { addLog } from './logger.js';
let lastCallTimestamp = 0;
const MIN_INTERVAL_MS = 400;
function getStateFilePath() {
    return path.join(config.DATA_DIR, 'light_state.json');
}
function loadPersistedState() {
    try {
        const filePath = getStateFilePath();
        if (fs.existsSync(filePath)) {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            return {
                on: Boolean(data.on),
                mode: data.mode === 'auto' ? 'auto' : 'manual',
                updatedAt: data.updatedAt || new Date().toISOString(),
            };
        }
    }
    catch {
        // Ignore read errors, fall through to default
    }
    return {
        on: false,
        mode: 'manual',
        updatedAt: new Date().toISOString(),
    };
}
function savePersistedState(state) {
    try {
        const filePath = getStateFilePath();
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf8');
    }
    catch (err) {
        addLog('warn', `No se pudo persistir el estado de la luz: ${err.message}`);
    }
}
let currentState = loadPersistedState();
export function getLightState() {
    return { ...currentState };
}
export async function setCameraLight(on) {
    const now = Date.now();
    if (now - lastCallTimestamp < MIN_INTERVAL_MS) {
        return {
            success: false,
            state: getLightState(),
            message: 'Demasiadas solicitudes. Espere un momento.',
        };
    }
    lastCallTimestamp = now;
    // Pelco-D Aux 1: Preset 64 = Light ON, Preset 65 = Light OFF
    const presetNumber = on ? 64 : 65;
    const url = `http://${config.CAMERA_HOST}:${config.CAMERA_PORT}/cgi-bin/hi3510/preset.cgi?-status=1&-act=goto&-number=${presetNumber}`;
    const authStr = `${config.CAMERA_USER}:${config.CAMERA_PASS}`;
    const b64Auth = Buffer.from(authStr, 'utf8').toString('base64');
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);
    try {
        const res = await fetch(url, {
            method: 'GET',
            headers: {
                Authorization: `Basic ${b64Auth}`,
            },
            signal: controller.signal,
        });
        clearTimeout(timeoutId);
        const bodyText = await res.text();
        const isOk = res.ok && (bodyText.includes('Success') || bodyText.includes('ok'));
        if (!isOk) {
            addLog('error', `Error al cambiar luz a ${on ? 'ON' : 'OFF'}: HTTP ${res.status} ${bodyText.trim()}`);
            return {
                success: false,
                state: getLightState(),
                message: `La cámara respondió con error: HTTP ${res.status}`,
            };
        }
        currentState = {
            on,
            mode: 'manual',
            updatedAt: new Date().toISOString(),
        };
        savePersistedState(currentState);
        addLog('info', `Luz de la cámara ${on ? 'ENCENDIDA' : 'APAGADA'} correctamente`);
        return {
            success: true,
            state: getLightState(),
        };
    }
    catch (err) {
        clearTimeout(timeoutId);
        const msg = err.name === 'AbortError' ? 'Tiempo de espera agotado al comunicar con la cámara' : err.message;
        addLog('error', `Fallo al cambiar luz de la cámara: ${msg}`);
        return {
            success: false,
            state: getLightState(),
            message: msg,
        };
    }
}
