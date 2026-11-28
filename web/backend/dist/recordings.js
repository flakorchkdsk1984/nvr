import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import chokidar from 'chokidar';
import { config } from './config.js';
import { addLog } from './logger.js';
const execFileAsync = promisify(execFile);
// Regex validators
export const FILE_REGEX = /^c2l_(\d{8})_(\d{6})\.mp4$/;
export const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
// In-memory cache for fast response
const segmentsCache = new Map();
const durationCache = new Map();
let watcher = null;
function readMp4MvhdDuration(filePath, sizeBytes) {
    let fd = null;
    try {
        fd = fs.openSync(filePath, 'r');
        const chunkLen = Math.min(sizeBytes, 65536);
        if (chunkLen < 32)
            return null;
        const buf = Buffer.allocUnsafe(chunkLen);
        fs.readSync(fd, buf, 0, chunkLen, 0);
        let idx = buf.indexOf('mvhd');
        if (idx === -1 && sizeBytes > chunkLen) {
            fs.readSync(fd, buf, 0, chunkLen, sizeBytes - chunkLen);
            idx = buf.indexOf('mvhd');
        }
        if (idx === -1 || idx + 32 > buf.length)
            return null;
        const version = buf[idx + 4];
        if (version === 0) {
            const timescale = buf.readUInt32BE(idx + 16);
            const duration = buf.readUInt32BE(idx + 20);
            return timescale > 0 ? duration / timescale : null;
        }
        if (version === 1 && idx + 36 <= buf.length) {
            const timescale = buf.readUInt32BE(idx + 24);
            const duration = Number(buf.readBigUInt64BE(idx + 28));
            return timescale > 0 ? duration / timescale : null;
        }
        return null;
    }
    catch {
        return null;
    }
    finally {
        if (fd !== null) {
            try {
                fs.closeSync(fd);
            }
            catch { }
        }
    }
}
export function getRecordingDurationSeconds(filePath, sizeBytes, mtimeMs) {
    const cached = durationCache.get(filePath);
    if (cached && cached.mtimeMs === mtimeMs && cached.size === sizeBytes) {
        return cached.durationSeconds;
    }
    const parsed = readMp4MvhdDuration(filePath, sizeBytes);
    // If valid and plausible (not an unfixed 12h legacy PTS jump), use exact mvhd duration.
    // Otherwise estimate from average camera bitrate (~68 KB/s).
    let durationSeconds;
    if (parsed !== null && isFinite(parsed) && parsed > 0 && parsed <= config.SEGMENT_SECONDS + 120) {
        durationSeconds = Math.round(parsed * 10) / 10;
    }
    else {
        durationSeconds = Math.max(10, Math.min(config.SEGMENT_SECONDS, Math.round(sizeBytes / 68000)));
    }
    durationCache.set(filePath, { mtimeMs, size: sizeBytes, durationSeconds });
    return durationSeconds;
}
// Ensure directories exist
if (!fs.existsSync(config.RECORDINGS_DIR)) {
    fs.mkdirSync(config.RECORDINGS_DIR, { recursive: true });
}
if (!fs.existsSync(config.THUMBS_DIR)) {
    fs.mkdirSync(config.THUMBS_DIR, { recursive: true });
}
export function validateRecordingPath(date, fileName) {
    if (!DATE_REGEX.test(date)) {
        throw new Error('Invalid date format (must be YYYY-MM-DD)');
    }
    if (!FILE_REGEX.test(fileName)) {
        throw new Error('Invalid recording file name');
    }
    const resolved = path.resolve(config.RECORDINGS_DIR, date, fileName);
    if (!resolved.startsWith(path.resolve(config.RECORDINGS_DIR))) {
        throw new Error('Access denied: path traversal detected');
    }
    return resolved;
}
export function parseFileNameTimestamp(fileName) {
    const match = fileName.match(FILE_REGEX);
    if (!match)
        return null;
    const dStr = match[1]; // YYYYMMDD
    const tStr = match[2]; // HHMMSS
    const dateFormatted = `${dStr.substring(0, 4)}-${dStr.substring(4, 6)}-${dStr.substring(6, 8)}`;
    const timeFormatted = `${tStr.substring(0, 2)}:${tStr.substring(2, 4)}:${tStr.substring(4, 6)}`;
    return {
        date: dateFormatted,
        time: timeFormatted,
        full: `${dateFormatted}T${timeFormatted}`,
    };
}
export function scanDateFolder(date) {
    if (!DATE_REGEX.test(date))
        return [];
    const dir = path.join(config.RECORDINGS_DIR, date);
    if (!fs.existsSync(dir))
        return [];
    const files = fs.readdirSync(dir);
    const now = Date.now();
    const segments = [];
    for (const f of files) {
        if (!FILE_REGEX.test(f))
            continue;
        const fPath = path.join(dir, f);
        try {
            const stat = fs.statSync(fPath);
            const parsedTime = parseFileNameTimestamp(f);
            if (!parsedTime)
                continue;
            // If file modified within 45 seconds and has size > 0, it's currently recording!
            const isRecent = (now - stat.mtimeMs) < 45000;
            const thumbFile = path.join(config.THUMBS_DIR, `${path.parse(f).name}.jpg`);
            segments.push({
                fileName: f,
                date,
                startTime: parsedTime.time,
                fullTimestamp: parsedTime.full,
                sizeBytes: stat.size,
                durationSeconds: isRecent ? config.SEGMENT_SECONDS : getRecordingDurationSeconds(fPath, stat.size, stat.mtimeMs),
                isRecording: isRecent,
                hasThumb: fs.existsSync(thumbFile),
            });
        }
        catch {
            // Ignore transient file lock errors
        }
    }
    // Sort chronologically
    segments.sort((a, b) => a.fileName.localeCompare(b.fileName));
    segmentsCache.set(date, segments);
    return segments;
}
export function getAvailableDays() {
    if (!fs.existsSync(config.RECORDINGS_DIR))
        return [];
    const entries = fs.readdirSync(config.RECORDINGS_DIR, { withFileTypes: true });
    const summaries = [];
    for (const ent of entries) {
        if (ent.isDirectory() && DATE_REGEX.test(ent.name)) {
            const segs = scanDateFolder(ent.name);
            if (segs.length > 0) {
                const totalSize = segs.reduce((acc, s) => acc + s.sizeBytes, 0);
                summaries.push({
                    date: ent.name,
                    segmentCount: segs.length,
                    totalSizeBytes: totalSize,
                });
            }
        }
    }
    summaries.sort((a, b) => b.date.localeCompare(a.date)); // Newest date first
    return summaries;
}
export async function generateThumbnail(date, fileName, atSeconds) {
    const filePath = validateRecordingPath(date, fileName);
    const baseName = path.parse(fileName).name;
    if (!fs.existsSync(config.THUMBS_DIR)) {
        fs.mkdirSync(config.THUMBS_DIR, { recursive: true });
    }
    if (!fs.existsSync(filePath)) {
        throw new Error('Recording file not found');
    }
    const stat = fs.statSync(filePath);
    const dur = getRecordingDurationSeconds(filePath, stat.size, stat.mtimeMs);
    let seekSec = 1;
    if (atSeconds !== undefined && isFinite(atSeconds) && atSeconds >= 0) {
        seekSec = Math.min(Math.max(0.5, atSeconds), Math.max(0.5, dur - 0.5));
    }
    else if (dur > 2 && dur <= 120) {
        // For motion clips (which include pre-roll), extract near midpoint of event rather than pre-roll frame 1s
        seekSec = Math.min(Math.max(1, Math.floor(dur / 2)), 12);
    }
    const suffix = (atSeconds !== undefined && isFinite(atSeconds) && atSeconds >= 0)
        ? `_at${Math.floor(seekSec)}`
        : '';
    const thumbPath = path.join(config.THUMBS_DIR, `${baseName}${suffix}.jpg`);
    if (fs.existsSync(thumbPath)) {
        return thumbPath;
    }
    try {
        await execFileAsync(config.FFMPEG_PATH, [
            '-y',
            '-ss', String(seekSec.toFixed(1)),
            '-i', filePath,
            '-vframes', '1',
            '-q:v', '3',
            '-vf', 'scale=320:-1',
            thumbPath,
        ], { timeout: 8000 });
        if (fs.existsSync(thumbPath) && fs.statSync(thumbPath).size > 0) {
            return thumbPath;
        }
        throw new Error('Empty thumbnail generated');
    }
    catch (err) {
        // Fallback to first frame
        try {
            await execFileAsync(config.FFMPEG_PATH, [
                '-y',
                '-i', filePath,
                '-vframes', '1',
                '-q:v', '3',
                '-vf', 'scale=320:-1',
                thumbPath,
            ], { timeout: 8000 });
            if (fs.existsSync(thumbPath) && fs.statSync(thumbPath).size > 0) {
                return thumbPath;
            }
            throw new Error('Empty fallback thumbnail');
        }
        catch {
            throw new Error(`Failed to generate thumbnail: ${err.message}`);
        }
    }
}
export async function exportClip(date, fileName, startSec, durationSec) {
    const filePath = validateRecordingPath(date, fileName);
    if (!fs.existsSync(filePath)) {
        throw new Error('Recording file not found');
    }
    if (startSec < 0 || durationSec <= 0 || durationSec > 3600) {
        throw new Error('Invalid start time or duration for clip');
    }
    const clipsDir = path.join(config.DATA_DIR, 'clips');
    if (!fs.existsSync(clipsDir)) {
        fs.mkdirSync(clipsDir, { recursive: true });
    }
    const clipFileName = `clip_${path.parse(fileName).name}_${Math.floor(startSec)}s_${Math.floor(durationSec)}s.mp4`;
    const clipPath = path.join(clipsDir, clipFileName);
    // Fast stream copy export without re-encoding
    await execFileAsync(config.FFMPEG_PATH, [
        '-y',
        '-ss', String(startSec),
        '-i', filePath,
        '-t', String(durationSec),
        '-c', 'copy',
        '-movflags', '+faststart',
        clipPath,
    ], { timeout: 30000 });
    addLog('info', `Exported clip: ${clipFileName} (${durationSec}s)`);
    return { clipPath, clipFileName };
}
export function deleteSegment(date, fileName) {
    const filePath = validateRecordingPath(date, fileName);
    if (!fs.existsSync(filePath)) {
        return false;
    }
    fs.unlinkSync(filePath);
    const baseName = path.parse(fileName).name;
    const thumbPath = path.join(config.THUMBS_DIR, `${baseName}.jpg`);
    if (fs.existsSync(thumbPath)) {
        try {
            fs.unlinkSync(thumbPath);
        }
        catch { }
    }
    // Refresh cache
    scanDateFolder(date);
    addLog('info', `Manually deleted recording: ${date}/${fileName}`);
    return true;
}
export class ProtectedDayError extends Error {
    statusCode = 409;
    constructor(message) {
        super(message);
        this.name = 'ProtectedDayError';
    }
}
export function isDayProtected(date) {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const todayLocal = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const todayUtc = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`;
    if (date >= todayLocal || date >= todayUtc) {
        return true;
    }
    const days = getAvailableDays();
    if (days.length > 0 && days[0].date === date) {
        return true;
    }
    return false;
}
export function deleteDay(date) {
    if (!DATE_REGEX.test(date)) {
        throw new Error('Invalid date format (must be YYYY-MM-DD)');
    }
    const recordingsRoot = path.resolve(config.RECORDINGS_DIR);
    const dirPath = path.resolve(recordingsRoot, date);
    if (!dirPath.startsWith(recordingsRoot + path.sep)) {
        throw new Error('Access denied: path traversal detected');
    }
    if (!fs.existsSync(dirPath)) {
        return null;
    }
    if (isDayProtected(date)) {
        throw new ProtectedDayError(`El día más reciente o en curso (${date}) está protegido y no se puede eliminar.`);
    }
    let deletedCount = 0;
    let freedBytes = 0;
    const files = fs.readdirSync(dirPath);
    for (const f of files) {
        const fPath = path.join(dirPath, f);
        try {
            const stat = fs.statSync(fPath);
            if (stat.isFile()) {
                fs.unlinkSync(fPath);
                deletedCount++;
                freedBytes += stat.size;
                const baseName = path.parse(f).name;
                if (fs.existsSync(config.THUMBS_DIR)) {
                    for (const t of fs.readdirSync(config.THUMBS_DIR)) {
                        if (t === `${baseName}.jpg` || t.startsWith(`${baseName}_at`)) {
                            try {
                                fs.unlinkSync(path.join(config.THUMBS_DIR, t));
                            }
                            catch { }
                        }
                    }
                }
            }
        }
        catch { }
    }
    segmentsCache.delete(date);
    try {
        if (fs.readdirSync(dirPath).length === 0) {
            fs.rmdirSync(dirPath);
        }
    }
    catch { }
    addLog('info', `Manually deleted recordings for day ${date}: ${deletedCount} files (${(freedBytes / 1024 / 1024).toFixed(2)} MB)`);
    return { deletedCount, freedBytes };
}
export function initRecordingsWatcher() {
    if (watcher)
        return;
    watcher = chokidar.watch(config.RECORDINGS_DIR, {
        ignored: /(^|[\/\\])\../,
        persistent: true,
        depth: 2,
        awaitWriteFinish: {
            stabilityThreshold: 2000,
            pollInterval: 1000,
        },
    });
    watcher.on('add', (filePath) => {
        const parts = filePath.split(path.sep);
        const date = parts[parts.length - 2];
        if (DATE_REGEX.test(date)) {
            scanDateFolder(date);
        }
    });
    watcher.on('unlink', (filePath) => {
        const parts = filePath.split(path.sep);
        const date = parts[parts.length - 2];
        if (DATE_REGEX.test(date)) {
            scanDateFolder(date);
        }
    });
}
export function findRecordingForEvent(startTimeIso, durationS = 0) {
    const CAMERA_NAME = 'C2L-Y-A (HD)';
    const eventDateObj = new Date(startTimeIso);
    const eventMs = eventDateObj.getTime();
    if (isNaN(eventMs)) {
        return { hasRecording: false, camera: CAMERA_NAME, message: 'Timestamp de evento inválido' };
    }
    // Check possible date folders: UTC and Local (in case of timezone day boundaries)
    const pad = (n) => String(n).padStart(2, '0');
    const utcDate = `${eventDateObj.getUTCFullYear()}-${pad(eventDateObj.getUTCMonth() + 1)}-${pad(eventDateObj.getUTCDate())}`;
    const localDate = `${eventDateObj.getFullYear()}-${pad(eventDateObj.getMonth() + 1)}-${pad(eventDateObj.getDate())}`;
    const prevDateObj = new Date(eventMs - 3600000);
    const prevUtcDate = `${prevDateObj.getUTCFullYear()}-${pad(prevDateObj.getUTCMonth() + 1)}-${pad(prevDateObj.getUTCDate())}`;
    const datesToCheck = Array.from(new Set([utcDate, localDate, prevUtcDate]));
    let bestDirectMatch = null;
    let bestSpanMatch = null;
    for (const date of datesToCheck) {
        if (!DATE_REGEX.test(date))
            continue;
        const dir = path.join(config.RECORDINGS_DIR, date);
        if (!fs.existsSync(dir))
            continue;
        const files = fs.readdirSync(dir).filter(f => FILE_REGEX.test(f));
        for (const f of files) {
            const match = f.match(FILE_REGEX);
            if (!match)
                continue;
            const fPath = path.join(dir, f);
            let stat;
            try {
                stat = fs.statSync(fPath);
            }
            catch {
                continue;
            }
            if (stat.size < 1000)
                continue;
            const dStr = match[1]; // YYYYMMDD
            const tStr = match[2]; // HHMMSS
            const year = parseInt(dStr.substring(0, 4), 10);
            const month = parseInt(dStr.substring(4, 6), 10) - 1;
            const day = parseInt(dStr.substring(6, 8), 10);
            const hours = parseInt(tStr.substring(0, 2), 10);
            const mins = parseInt(tStr.substring(2, 4), 10);
            const secs = parseInt(tStr.substring(4, 6), 10);
            const fileUtcMs = Date.UTC(year, month, day, hours, mins, secs);
            const fileLocalMs = new Date(year, month, day, hours, mins, secs).getTime();
            const fileDuration = getRecordingDurationSeconds(fPath, stat.size, stat.mtimeMs);
            for (const fileStartMs of [fileUtcMs, fileLocalMs]) {
                const diffSeconds = (eventMs - fileStartMs) / 1000;
                const absDiff = Math.abs(diffSeconds);
                // Pass 1: Direct motion clip match (file started within [-15s, +25s] of event)
                if (diffSeconds >= -15 && diffSeconds <= 25) {
                    if (!bestDirectMatch || absDiff < bestDirectMatch.absDiff) {
                        bestDirectMatch = { date, fileName: f, diffSeconds, absDiff, fileDuration };
                    }
                }
                // Pass 2: Continuous or spanning segment match (event strictly inside real clip duration)
                if (diffSeconds >= 0 && diffSeconds < fileDuration) {
                    if (!bestSpanMatch || diffSeconds < bestSpanMatch.diffSeconds) {
                        bestSpanMatch = { date, fileName: f, diffSeconds, absDiff, fileDuration };
                    }
                }
            }
        }
    }
    const chosen = bestDirectMatch || bestSpanMatch;
    if (chosen) {
        const offsetSeconds = Math.max(0, Math.round(chosen.diffSeconds * 10) / 10);
        const thumbQuery = offsetSeconds > 2 ? `?at=${Math.round(offsetSeconds + 2)}` : '';
        return {
            hasRecording: true,
            camera: CAMERA_NAME,
            date: chosen.date,
            fileName: chosen.fileName,
            videoUrl: `/api/recordings/${chosen.date}/${chosen.fileName}`,
            thumbUrl: `/api/recordings/${chosen.date}/${chosen.fileName}/thumb${thumbQuery}`,
            offsetSeconds,
            durationSeconds: Math.max(chosen.fileDuration, durationS || 0),
        };
    }
    return {
        hasRecording: false,
        camera: CAMERA_NAME,
        message: 'No se encontró grabación archivada para el intervalo de este evento.',
    };
}
