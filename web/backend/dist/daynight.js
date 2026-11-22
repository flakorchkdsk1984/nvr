import path from 'path';
import fs from 'fs';
import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import { config } from './config.js';
import { addLog } from './logger.js';
import { getMotionEngine } from './motion.js';
export const dayNightEvents = new EventEmitter();
function getStateFilePath() {
    return path.join(config.DATA_DIR, 'daynight_state.json');
}
function loadPersistedState() {
    try {
        const filePath = getStateFilePath();
        if (fs.existsSync(filePath)) {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            return {
                state: data.state === 'day' || data.state === 'night' ? data.state : 'unknown',
                source: 'inferred',
                saturation: typeof data.saturation === 'number' ? data.saturation : 0,
                brightness: typeof data.brightness === 'number' ? data.brightness : 0,
                updatedAt: data.updatedAt || new Date().toISOString(),
            };
        }
    }
    catch {
        // Ignore read errors
    }
    return {
        state: 'unknown',
        source: 'inferred',
        saturation: 0,
        brightness: 0,
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
        addLog('warn', `No se pudo persistir el estado día/noche: ${err.message}`);
    }
}
let currentState = loadPersistedState();
let isChecking = false;
let pollerTimer = null;
let consecutiveCount = 0;
let pendingCandidateState = null;
export const REQUIRED_CONSECUTIVE_READINGS = 2;
/**
 * Pure evaluation function for day/night state transition with hysteresis and debouncing.
 */
export function evaluateDayNightTransition(saturation, currentState, pendingCandidate, consecutiveCount, nightThreshold = config.DAYNIGHT_SAT_NIGHT_THRESHOLD, dayThreshold = config.DAYNIGHT_SAT_DAY_THRESHOLD, requiredConsecutive = REQUIRED_CONSECUTIVE_READINGS) {
    let candidate;
    if (saturation <= nightThreshold) {
        candidate = 'night';
    }
    else if (saturation > dayThreshold) {
        candidate = 'day';
    }
    else {
        // In hysteresis band: maintain current valid state if known, otherwise default to day
        candidate = currentState === 'night' ? 'night' : 'day';
    }
    if (candidate === currentState) {
        return {
            candidate,
            nextState: currentState,
            nextPending: null,
            nextConsecutive: 0,
            isTransition: false,
        };
    }
    let nextPending = pendingCandidate;
    let nextConsecutive = consecutiveCount;
    if (candidate === pendingCandidate) {
        nextConsecutive++;
    }
    else {
        nextPending = candidate;
        nextConsecutive = 1;
    }
    if (nextConsecutive >= requiredConsecutive || currentState === 'unknown') {
        return {
            candidate,
            nextState: candidate,
            nextPending: null,
            nextConsecutive: 0,
            isTransition: true,
        };
    }
    return {
        candidate,
        nextState: currentState,
        nextPending,
        nextConsecutive,
        isTransition: false,
    };
}
export function getDayNightState() {
    return { ...currentState };
}
/**
 * Analyzes JPEG buffer by scaling to 64x36 via FFmpeg and computing average HSV saturation and brightness.
 */
function analyzeImageHsv(jpegBuffer) {
    return new Promise((resolve, reject) => {
        const proc = spawn(config.FFMPEG_PATH, [
            '-loglevel', 'error',
            '-y',
            '-i', 'pipe:0',
            '-vf', 'scale=64:36',
            '-f', 'rawvideo',
            '-pix_fmt', 'rgb24',
            'pipe:1',
        ], {
            stdio: ['pipe', 'pipe', 'ignore'],
        });
        const chunks = [];
        proc.stdout.on('data', (c) => chunks.push(c));
        proc.on('close', (code) => {
            if (code !== 0 && chunks.length === 0) {
                return reject(new Error(`FFmpeg falló al analizar snapshot (código ${code})`));
            }
            const raw = Buffer.concat(chunks);
            const numPixels = Math.floor(raw.length / 3);
            if (numPixels === 0) {
                return reject(new Error('Buffer de imagen vacío tras procesamiento FFmpeg'));
            }
            let totalSat = 0;
            let totalBri = 0;
            for (let i = 0; i < raw.length - 2; i += 3) {
                const r = raw[i];
                const g = raw[i + 1];
                const b = raw[i + 2];
                const max = Math.max(r, g, b);
                const min = Math.min(r, g, b);
                const delta = max - min;
                // HSV Saturation: 0 if max is 0, else delta / max
                const sat = max === 0 ? 0 : delta / max;
                totalSat += sat;
                totalBri += max / 255.0;
            }
            const meanSatPct = Math.round((totalSat / numPixels) * 10000) / 100; // e.g. 21.45%
            const meanBriPct = Math.round((totalBri / numPixels) * 10000) / 100; // e.g. 48.20%
            resolve({ saturation: meanSatPct, brightness: meanBriPct });
        });
        proc.on('error', (err) => reject(err));
        proc.stdin.write(jpegBuffer);
        proc.stdin.end();
    });
}
/**
 * Executes a single inference check against the camera's /snapshot.jpg endpoint.
 */
export async function checkDayNight() {
    if (isChecking) {
        return getDayNightState();
    }
    isChecking = true;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);
    try {
        const authStr = `${config.CAMERA_USER}:${config.CAMERA_PASS}`;
        const b64Auth = Buffer.from(authStr, 'utf8').toString('base64');
        const url = `http://${config.CAMERA_HOST}:${config.CAMERA_PORT}/snapshot.jpg`;
        const res = await fetch(url, {
            headers: {
                Authorization: `Basic ${b64Auth}`,
            },
            signal: controller.signal,
        });
        clearTimeout(timeoutId);
        if (!res.ok) {
            throw new Error(`HTTP ${res.status} al consultar snapshot de cámara`);
        }
        const arrayBuffer = await res.arrayBuffer();
        const jpegBuffer = Buffer.from(arrayBuffer);
        const { saturation, brightness } = await analyzeImageHsv(jpegBuffer);
        const evalResult = evaluateDayNightTransition(saturation, currentState.state, pendingCandidateState, consecutiveCount);
        pendingCandidateState = evalResult.nextPending;
        consecutiveCount = evalResult.nextConsecutive;
        if (evalResult.isTransition) {
            const previous = currentState.state;
            currentState = {
                state: evalResult.nextState,
                source: 'inferred',
                saturation,
                brightness,
                updatedAt: new Date().toISOString(),
            };
            savePersistedState(currentState);
            // Suppress motion detection during state change to prevent false alarms
            getMotionEngine().suppressMotion(config.DAYNIGHT_SWITCH_GRACE_S);
            addLog('info', `Cambio de modo día/noche detectado: [${previous.toUpperCase()} -> ${currentState.state.toUpperCase()}] ` +
                `(Saturación: ${saturation}%, Brillo: ${brightness}%). Detección de movimiento suprimida por ${config.DAYNIGHT_SWITCH_GRACE_S}s.`);
            dayNightEvents.emit('change', currentState);
            return getDayNightState();
        }
        // Update current metrics without changing state
        currentState = {
            ...currentState,
            saturation,
            brightness,
            updatedAt: new Date().toISOString(),
        };
        savePersistedState(currentState);
    }
    catch (err) {
        clearTimeout(timeoutId);
        // Do not alter state on transient network failures
    }
    finally {
        isChecking = false;
    }
    return getDayNightState();
}
export function startDayNightPoller() {
    if (pollerTimer)
        return;
    // Run immediate first check
    checkDayNight().catch(() => { });
    const intervalMs = Math.max(5, config.DAYNIGHT_POLL_INTERVAL_S) * 1000;
    pollerTimer = setInterval(() => {
        checkDayNight().catch(() => { });
    }, intervalMs);
}
export function stopDayNightPoller() {
    if (pollerTimer) {
        clearInterval(pollerTimer);
        pollerTimer = null;
    }
}
