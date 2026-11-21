import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { config } from './config.js';
import { addLog } from './logger.js';
export const PtzMoveSchema = z.object({
    action: z.enum(['up', 'down', 'left', 'right', 'zoomin', 'zoomout', 'stop']),
    step: z.union([z.literal(0), z.literal(1)]).default(1),
    speed: z.number().int().min(1).max(8).default(5),
});
export const PtzPresetSchema = z.object({
    action: z.enum(['goto', 'set']),
    number: z.number().int().min(1).max(8),
    name: z.string().max(40).optional(),
});
const presetsFile = path.join(config.DATA_DIR, 'presets.json');
function loadPresets() {
    try {
        if (fs.existsSync(presetsFile)) {
            const data = JSON.parse(fs.readFileSync(presetsFile, 'utf8'));
            return data;
        }
    }
    catch (err) {
        addLog('error', 'Failed to read presets file', String(err));
    }
    const defaultPresets = {};
    for (let i = 1; i <= 8; i++) {
        defaultPresets[i] = { number: i, name: `Preset ${i}` };
    }
    return defaultPresets;
}
function savePresets(presets) {
    try {
        fs.writeFileSync(presetsFile, JSON.stringify(presets, null, 2), 'utf8');
    }
    catch (err) {
        addLog('error', 'Failed to save presets file', String(err));
    }
}
// Throttle / Mutex state
let lastPtzTime = 0;
const MIN_INTERVAL_MS = 120;
async function sendCameraCgi(endpoint, timeoutMs = 8000) {
    const url = `http://${config.CAMERA_HOST}:${config.CAMERA_PORT}${endpoint}`;
    const authStr = `${config.CAMERA_USER}:${config.CAMERA_PASS}`;
    const b64Auth = Buffer.from(authStr, 'utf8').toString('base64');
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            method: 'GET',
            headers: {
                'Authorization': `Basic ${b64Auth}`,
            },
            signal: controller.signal,
        });
        clearTimeout(timeoutId);
        const body = (await res.text()).trim();
        if (res.ok) {
            return { success: true, status: res.status, message: body };
        }
        return { success: false, status: res.status, message: body || res.statusText };
    }
    catch (err) {
        clearTimeout(timeoutId);
        return { success: false, status: 0, message: err.name === 'AbortError' ? 'Camera request timeout' : err.message };
    }
}
export async function executePtzMove(params) {
    const now = Date.now();
    if (now - lastPtzTime < MIN_INTERVAL_MS) {
        await new Promise((r) => setTimeout(r, MIN_INTERVAL_MS - (now - lastPtzTime)));
    }
    lastPtzTime = Date.now();
    let endpoint;
    if (params.action === 'stop') {
        endpoint = '/cgi-bin/hi3510/ptzctrl.cgi?-step=0&-act=stop';
    }
    else {
        endpoint = `/cgi-bin/hi3510/ptzctrl.cgi?-step=${params.step}&-act=${params.action}&-speed=${params.speed}`;
    }
    const result = await sendCameraCgi(endpoint, 5000);
    if (!result.success) {
        addLog('warn', `PTZ command failed: ${params.action}`, result.message);
    }
    return result;
}
export async function executePtzPreset(params) {
    const endpoint = `/cgi-bin/hi3510/preset.cgi?-status=1&-act=${params.action}&-number=${params.number}`;
    const result = await sendCameraCgi(endpoint, 12000);
    if (result.success) {
        const presets = loadPresets();
        if (params.action === 'set') {
            presets[params.number] = {
                number: params.number,
                name: params.name || presets[params.number]?.name || `Preset ${params.number}`,
                updatedAt: new Date().toISOString(),
            };
            savePresets(presets);
            addLog('info', `Saved Preset ${params.number}: ${presets[params.number].name}`);
        }
    }
    else {
        addLog('warn', `Preset command failed: ${params.action} ${params.number}`, result.message);
    }
    return result;
}
export function getPresetsList() {
    const map = loadPresets();
    const list = [];
    for (let i = 1; i <= 8; i++) {
        list.push(map[i] || { number: i, name: `Preset ${i}` });
    }
    return list;
}
