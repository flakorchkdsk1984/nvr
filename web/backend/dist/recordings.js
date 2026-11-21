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
let watcher = null;
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
                durationSeconds: config.SEGMENT_SECONDS,
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
export async function generateThumbnail(date, fileName) {
    const filePath = validateRecordingPath(date, fileName);
    const baseName = path.parse(fileName).name;
    const thumbPath = path.join(config.THUMBS_DIR, `${baseName}.jpg`);
    if (fs.existsSync(thumbPath)) {
        return thumbPath;
    }
    if (!fs.existsSync(filePath)) {
        throw new Error('Recording file not found');
    }
    try {
        // Extract 1 frame at 0.5s or 1s
        await execFileAsync(config.FFMPEG_PATH, [
            '-y',
            '-ss', '00:00:01',
            '-i', filePath,
            '-vframes', '1',
            '-q:v', '3',
            '-vf', 'scale=320:-1',
            thumbPath,
        ], { timeout: 8000 });
        return thumbPath;
    }
    catch (err) {
        // If extraction at 1s fails (e.g. very short file), try frame 0
        try {
            await execFileAsync(config.FFMPEG_PATH, [
                '-y',
                '-i', filePath,
                '-vframes', '1',
                '-q:v', '3',
                '-vf', 'scale=320:-1',
                thumbPath,
            ], { timeout: 8000 });
            return thumbPath;
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
