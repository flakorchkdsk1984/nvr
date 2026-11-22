import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { config } from './config.js';
import { addLog } from './logger.js';
import { getMotionEngine } from './motion.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
class RecorderManager {
    mode = 'continuous';
    continuousProcess = null;
    prerollProcess = null;
    motionRecordProcess = null;
    activeMotionFile = null;
    activeMotionTarget = null;
    prerollSnapshotFiles = [];
    postrollTimer = null;
    isMotionActive = false;
    isRecordingMotion = false;
    prerollCleanupInterval = null;
    initialized = false;
    constructor() {
        this.mode = this.loadPersistedMode();
    }
    getModeFilePath() {
        return path.join(config.DATA_DIR, 'recorder_mode.json');
    }
    loadPersistedMode() {
        try {
            const p = this.getModeFilePath();
            if (fs.existsSync(p)) {
                const data = JSON.parse(fs.readFileSync(p, 'utf8'));
                if (data.mode === 'continuous' || data.mode === 'motion' || data.mode === 'paused') {
                    return data.mode;
                }
            }
        }
        catch { }
        return config.RECORDING_MODE || 'continuous';
    }
    persistMode(mode) {
        try {
            const p = this.getModeFilePath();
            const dir = path.dirname(p);
            if (!fs.existsSync(dir))
                fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(p, JSON.stringify({ mode, updatedAt: new Date().toISOString() }, null, 2));
        }
        catch (err) {
            addLog('warn', `No se pudo persistir modo de grabación: ${err.message}`);
        }
    }
    init() {
        if (this.initialized)
            return;
        this.initialized = true;
        // Ensure directories
        const prerollDir = path.join(config.DATA_DIR, 'preroll');
        if (!fs.existsSync(prerollDir))
            fs.mkdirSync(prerollDir, { recursive: true });
        // Hook up motion events
        const motionEngine = getMotionEngine();
        motionEngine.on('motion-start', () => this.handleMotionStart());
        motionEngine.on('motion-active', () => this.handleMotionActive());
        motionEngine.on('motion-end', () => this.handleMotionEnd());
        // Start in current mode
        this.applyMode(this.mode);
    }
    getStatus() {
        const prerollDir = path.join(config.DATA_DIR, 'preroll');
        let prerollCount = 0;
        try {
            if (fs.existsSync(prerollDir)) {
                prerollCount = fs.readdirSync(prerollDir).filter(f => f.endsWith('.mp4')).length;
            }
        }
        catch { }
        const isRunning = this.mode === 'continuous'
            ? !!this.continuousProcess
            : this.mode === 'motion'
                ? !!this.prerollProcess || this.isRecordingMotion
                : false;
        return {
            mode: this.mode,
            active: isRunning,
            isRecordingMotion: this.isRecordingMotion,
            currentSegment: this.activeMotionTarget || undefined,
            prerollBufferCount: prerollCount,
        };
    }
    async setMode(newMode) {
        if (this.mode === newMode && this.getStatus().active) {
            return this.getStatus();
        }
        addLog('info', `Cambiando modo de grabación de '${this.mode}' a '${newMode}'`);
        this.mode = newMode;
        this.persistMode(newMode);
        await this.applyMode(newMode);
        return this.getStatus();
    }
    async applyMode(mode) {
        this.stopAll();
        if (mode === 'continuous') {
            this.startContinuous();
        }
        else if (mode === 'motion') {
            this.startMotionMode();
        }
        else if (mode === 'paused') {
            addLog('info', 'Grabación pausada');
        }
    }
    stopAll() {
        if (this.postrollTimer) {
            clearTimeout(this.postrollTimer);
            this.postrollTimer = null;
        }
        if (this.prerollCleanupInterval) {
            clearInterval(this.prerollCleanupInterval);
            this.prerollCleanupInterval = null;
        }
        if (this.continuousProcess) {
            try {
                this.continuousProcess.kill('SIGTERM');
            }
            catch { }
            this.continuousProcess = null;
        }
        if (this.prerollProcess) {
            try {
                this.prerollProcess.kill('SIGTERM');
            }
            catch { }
            this.prerollProcess = null;
        }
        if (this.motionRecordProcess) {
            try {
                this.motionRecordProcess.kill('SIGTERM');
            }
            catch { }
            this.motionRecordProcess = null;
        }
        this.isRecordingMotion = false;
        this.activeMotionFile = null;
        this.activeMotionTarget = null;
        this.prerollSnapshotFiles = [];
    }
    // ==========================================
    // CONTINUOUS 24/7 MODE
    // ==========================================
    startContinuous() {
        addLog('info', 'Iniciando grabación continua 24/7');
        const rtspUrl = `${config.GO2RTC_RTSP}/c2l_hd`;
        const recDir = config.RECORDINGS_DIR;
        const segmentLen = config.SEGMENT_SECONDS;
        if (!fs.existsSync(recDir))
            fs.mkdirSync(recDir, { recursive: true });
        const args = [
            '-hide_banner', '-loglevel', 'warning',
            '-rtsp_transport', 'tcp',
            '-i', rtspUrl,
            '-c', 'copy',
            '-movflags', '+faststart',
            '-f', 'segment',
            '-segment_time', String(segmentLen),
            '-reset_timestamps', '1',
            '-strftime', '1',
            path.join(recDir, '%Y-%m-%d', 'c2l_%Y%m%d_%H%M%S.mp4'),
        ];
        try {
            this.continuousProcess = spawn(config.FFMPEG_PATH, args, {
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            this.continuousProcess.on('exit', (code) => {
                this.continuousProcess = null;
                if (this.mode === 'continuous') {
                    addLog('warn', `Proceso FFmpeg continuo finalizó (${code}). Reiniciando en 3s...`);
                    setTimeout(() => {
                        if (this.mode === 'continuous')
                            this.startContinuous();
                    }, 3000);
                }
            });
        }
        catch (err) {
            addLog('error', `Error al iniciar grabación continua: ${err.message}`);
        }
    }
    // ==========================================
    // MOTION-ONLY MODE WITH PRE-ROLL BUFFER
    // ==========================================
    startMotionMode() {
        addLog('info', 'Modo de grabación "Solo Movimiento" activado con buffer pre-roll');
        this.startPrerollBuffer();
        // Clean up old preroll segments every 5 seconds
        this.prerollCleanupInterval = setInterval(() => {
            this.cleanPrerollBuffer();
        }, 5000);
    }
    startPrerollBuffer() {
        const prerollDir = path.join(config.DATA_DIR, 'preroll');
        if (!fs.existsSync(prerollDir))
            fs.mkdirSync(prerollDir, { recursive: true });
        const rtspUrl = `${config.GO2RTC_RTSP}/c2l_hd`;
        // 3-second segments for pre-roll
        const args = [
            '-hide_banner', '-loglevel', 'warning',
            '-rtsp_transport', 'tcp',
            '-i', rtspUrl,
            '-c', 'copy',
            '-f', 'segment',
            '-segment_time', '3',
            '-reset_timestamps', '1',
            '-strftime', '1',
            path.join(prerollDir, 'pre_%Y%m%d_%H%M%S.mp4'),
        ];
        try {
            this.prerollProcess = spawn(config.FFMPEG_PATH, args, {
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            this.prerollProcess.on('exit', (code) => {
                this.prerollProcess = null;
                if (this.mode === 'motion') {
                    setTimeout(() => {
                        if (this.mode === 'motion')
                            this.startPrerollBuffer();
                    }, 2000);
                }
            });
        }
        catch (err) {
            addLog('error', `Error al iniciar buffer pre-roll: ${err.message}`);
        }
    }
    cleanPrerollBuffer() {
        try {
            const prerollDir = path.join(config.DATA_DIR, 'preroll');
            if (!fs.existsSync(prerollDir))
                return;
            const files = fs.readdirSync(prerollDir)
                .filter(f => f.startsWith('pre_') && f.endsWith('.mp4'))
                .map(f => ({
                name: f,
                fullPath: path.join(prerollDir, f),
                mtime: fs.statSync(path.join(prerollDir, f)).mtimeMs,
            }))
                .sort((a, b) => b.mtime - a.mtime);
            // Keep only the most recent N segments (~4 segments * 3s = 12s buffer)
            const maxKeep = Math.ceil(config.PREROLL_S / 3) + 1;
            if (files.length > maxKeep) {
                for (let i = maxKeep; i < files.length; i++) {
                    try {
                        // Do not delete files currently snapshotted in active motion recording
                        if (!this.prerollSnapshotFiles.includes(files[i].fullPath)) {
                            fs.unlinkSync(files[i].fullPath);
                        }
                    }
                    catch { }
                }
            }
        }
        catch { }
    }
    handleMotionStart() {
        if (this.mode !== 'motion')
            return;
        this.isMotionActive = true;
        if (this.postrollTimer) {
            clearTimeout(this.postrollTimer);
            this.postrollTimer = null;
        }
        if (!this.isRecordingMotion) {
            this.beginMotionRecording();
        }
    }
    handleMotionActive() {
        if (this.mode !== 'motion')
            return;
        this.isMotionActive = true;
        if (this.postrollTimer) {
            clearTimeout(this.postrollTimer);
            this.postrollTimer = null;
        }
    }
    handleMotionEnd() {
        if (this.mode !== 'motion')
            return;
        this.isMotionActive = false;
        if (this.isRecordingMotion && !this.postrollTimer) {
            const postrollMs = config.POSTROLL_S * 1000;
            addLog('info', `Esperando post-roll de ${config.POSTROLL_S}s antes de finalizar clip de movimiento...`);
            this.postrollTimer = setTimeout(() => {
                this.finalizeMotionRecording();
            }, postrollMs);
        }
    }
    beginMotionRecording() {
        this.isRecordingMotion = true;
        const now = new Date();
        const dateStr = now.toISOString().slice(0, 10);
        const dateDir = path.join(config.RECORDINGS_DIR, dateStr);
        if (!fs.existsSync(dateDir))
            fs.mkdirSync(dateDir, { recursive: true });
        const pad = (n) => String(n).padStart(2, '0');
        const timestampStr = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
        const targetFile = path.join(dateDir, `c2l_${timestampStr}.mp4`);
        this.activeMotionTarget = targetFile;
        // Snapshot current pre-roll files
        const prerollDir = path.join(config.DATA_DIR, 'preroll');
        let preFiles = [];
        try {
            preFiles = fs.readdirSync(prerollDir)
                .filter(f => f.startsWith('pre_') && f.endsWith('.mp4'))
                .map(f => path.join(prerollDir, f))
                .sort(); // Lexicographical sort corresponds to timestamp
            // Take the last N files
            const maxPre = Math.ceil(config.PREROLL_S / 3);
            if (preFiles.length > maxPre) {
                preFiles = preFiles.slice(preFiles.length - maxPre);
            }
        }
        catch { }
        this.prerollSnapshotFiles = [...preFiles];
        // Live segment to capture
        const tempLiveFile = path.join(prerollDir, `active_${timestampStr}.mp4`);
        this.activeMotionFile = tempLiveFile;
        const rtspUrl = `${config.GO2RTC_RTSP}/c2l_hd`;
        const args = [
            '-hide_banner', '-loglevel', 'warning',
            '-rtsp_transport', 'tcp',
            '-i', rtspUrl,
            '-c', 'copy',
            '-movflags', '+faststart',
            tempLiveFile,
        ];
        addLog('info', `Iniciando captura de segmento por movimiento: ${path.basename(targetFile)}`);
        try {
            this.motionRecordProcess = spawn(config.FFMPEG_PATH, args, {
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            this.motionRecordProcess.on('exit', () => {
                this.motionRecordProcess = null;
            });
        }
        catch (err) {
            addLog('error', `Error al iniciar captura de movimiento: ${err.message}`);
        }
    }
    async finalizeMotionRecording() {
        if (!this.isRecordingMotion)
            return;
        this.postrollTimer = null;
        this.isRecordingMotion = false;
        const liveFile = this.activeMotionFile;
        const targetFile = this.activeMotionTarget;
        const preFiles = [...this.prerollSnapshotFiles];
        if (this.motionRecordProcess) {
            try {
                this.motionRecordProcess.kill('SIGINT');
            }
            catch { }
            this.motionRecordProcess = null;
        }
        // Wait 1.5s for FFmpeg to write trailer and exit
        await new Promise((r) => setTimeout(r, 1500));
        if (!targetFile)
            return;
        try {
            const validPre = preFiles.filter(f => fs.existsSync(f) && fs.statSync(f).size > 1000);
            const hasLive = liveFile && fs.existsSync(liveFile) && fs.statSync(liveFile).size > 1000;
            if (!hasLive && validPre.length === 0) {
                addLog('warn', 'No se generaron datos para el clip de movimiento');
                return;
            }
            const allFiles = [...validPre];
            if (hasLive && liveFile) {
                allFiles.push(liveFile);
            }
            if (allFiles.length === 1) {
                // Just move the file directly
                fs.renameSync(allFiles[0], targetFile);
            }
            else if (allFiles.length > 1) {
                // Concat files using ffmpeg concat demuxer
                const listFile = path.join(config.DATA_DIR, 'preroll', `concat_${Date.now()}.txt`);
                const content = allFiles.map(f => `file '${f}'`).join('\n');
                fs.writeFileSync(listFile, content, 'utf8');
                await new Promise((resolve, reject) => {
                    const concatProc = spawn(config.FFMPEG_PATH, [
                        '-hide_banner', '-loglevel', 'warning',
                        '-f', 'concat',
                        '-safe', '0',
                        '-i', listFile,
                        '-c', 'copy',
                        '-movflags', '+faststart',
                        '-y',
                        targetFile,
                    ]);
                    concatProc.on('exit', (code) => {
                        try {
                            fs.unlinkSync(listFile);
                        }
                        catch { }
                        if (code === 0)
                            resolve();
                        else
                            reject(new Error(`Concat exited with code ${code}`));
                    });
                    concatProc.on('error', (err) => {
                        try {
                            fs.unlinkSync(listFile);
                        }
                        catch { }
                        reject(err);
                    });
                });
            }
            // Cleanup temp live file if still present
            if (liveFile && fs.existsSync(liveFile)) {
                try {
                    fs.unlinkSync(liveFile);
                }
                catch { }
            }
            const stat = fs.statSync(targetFile);
            addLog('info', `Clip de movimiento guardado: ${path.basename(targetFile)} (${Math.round(stat.size / 1024 / 1024 * 10) / 10} MB)`);
        }
        catch (err) {
            addLog('error', `Error finalizando grabación de movimiento: ${err.message}`);
        }
        finally {
            this.activeMotionFile = null;
            this.activeMotionTarget = null;
            this.prerollSnapshotFiles = [];
        }
    }
}
let instance = null;
export function getRecorderManager() {
    if (!instance) {
        instance = new RecorderManager();
    }
    return instance;
}
export function initRecorderManager() {
    const mgr = getRecorderManager();
    mgr.init();
    return mgr;
}
