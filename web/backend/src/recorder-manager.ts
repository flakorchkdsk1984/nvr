import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { spawn, ChildProcess } from 'child_process';
import { config } from './config.js';
import { addLog } from './logger.js';
import { getMotionEngine } from './motion.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type RecordingMode = 'continuous' | 'motion' | 'paused';

export interface RecorderStatus {
  mode: RecordingMode;
  active: boolean;
  isRecordingMotion: boolean;
  currentSegment?: string;
  prerollBufferCount: number;
}

class RecorderManager {
  private mode: RecordingMode = 'continuous';
  private continuousProcess: ChildProcess | null = null;
  private prerollProcess: ChildProcess | null = null;
  private motionRecordProcess: ChildProcess | null = null;
  private activeMotionFile: string | null = null;
  private activeMotionTarget: string | null = null;
  private prerollSnapshotFiles: string[] = [];
  private postrollTimer: NodeJS.Timeout | null = null;
  private isMotionActive = false;
  private isRecordingMotion = false;
  private prerollCleanupInterval: NodeJS.Timeout | null = null;
  private dateDirInterval: NodeJS.Timeout | null = null;
  private initialized = false;

  constructor() {
    this.mode = this.loadPersistedMode();
  }

  private getModeFilePath(): string {
    return path.join(config.DATA_DIR, 'recorder_mode.json');
  }

  private loadPersistedMode(): RecordingMode {
    try {
      const p = this.getModeFilePath();
      if (fs.existsSync(p)) {
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (data.mode === 'continuous' || data.mode === 'motion' || data.mode === 'paused') {
          return data.mode;
        }
      }
    } catch {}
    return (config.RECORDING_MODE as RecordingMode) || 'continuous';
  }

  private persistMode(mode: RecordingMode): void {
    try {
      const p = this.getModeFilePath();
      const dir = path.dirname(p);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(p, JSON.stringify({ mode, updatedAt: new Date().toISOString() }, null, 2));
    } catch (err: any) {
      addLog('warn', `No se pudo persistir modo de grabación: ${err.message}`);
    }
  }

  public init(): void {
    if (this.initialized) return;
    this.initialized = true;

    // Ensure directories
    const prerollDir = path.join(config.DATA_DIR, 'preroll');
    if (!fs.existsSync(prerollDir)) fs.mkdirSync(prerollDir, { recursive: true });

    // Hook up motion events
    const motionEngine = getMotionEngine();
    motionEngine.on('motion-start', () => this.handleMotionStart());
    motionEngine.on('motion-active', () => this.handleMotionActive());
    motionEngine.on('motion-end', () => this.handleMotionEnd());

    // Start in current mode
    this.applyMode(this.mode);
  }

  public getStatus(): RecorderStatus {
    const prerollDir = path.join(config.DATA_DIR, 'preroll');
    let prerollCount = 0;
    try {
      if (fs.existsSync(prerollDir)) {
        prerollCount = fs.readdirSync(prerollDir).filter(f => f.endsWith('.mp4')).length;
      }
    } catch {}

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

  public async setMode(newMode: RecordingMode): Promise<RecorderStatus> {
    if (this.mode === newMode && this.getStatus().active) {
      return this.getStatus();
    }

    addLog('info', `Cambiando modo de grabación de '${this.mode}' a '${newMode}'`);
    this.mode = newMode;
    this.persistMode(newMode);
    await this.applyMode(newMode);
    return this.getStatus();
  }

  private async applyMode(mode: RecordingMode): Promise<void> {
    this.stopAll();

    if (mode === 'continuous') {
      this.startContinuous();
    } else if (mode === 'motion') {
      this.startMotionMode();
    } else if (mode === 'paused') {
      addLog('info', 'Grabación pausada');
    }
  }

  private stopAll(): void {
    if (this.postrollTimer) {
      clearTimeout(this.postrollTimer);
      this.postrollTimer = null;
    }
    if (this.prerollCleanupInterval) {
      clearInterval(this.prerollCleanupInterval);
      this.prerollCleanupInterval = null;
    }
    if (this.dateDirInterval) {
      clearInterval(this.dateDirInterval);
      this.dateDirInterval = null;
    }

    if (this.continuousProcess) {
      try { this.continuousProcess.kill('SIGTERM'); } catch {}
      this.continuousProcess = null;
    }

    if (this.prerollProcess) {
      try { this.prerollProcess.kill('SIGTERM'); } catch {}
      this.prerollProcess = null;
    }

    if (this.motionRecordProcess) {
      try { this.motionRecordProcess.kill('SIGTERM'); } catch {}
      this.motionRecordProcess = null;
    }

    this.isRecordingMotion = false;
    this.activeMotionFile = null;
    this.activeMotionTarget = null;
    this.prerollSnapshotFiles = [];
  }

  private ensureDateDirectories(recDir: string): void {
    const pad = (n: number) => String(n).padStart(2, '0');
    for (const offsetDays of [0, 1]) {
      const d = new Date(Date.now() + offsetDays * 86400000);
      const dateFolder = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      const full = path.join(recDir, dateFolder);
      if (!fs.existsSync(full)) fs.mkdirSync(full, { recursive: true });
    }
  }

  // ==========================================
  // CONTINUOUS 24/7 MODE
  // ==========================================
  private startContinuous(): void {
    addLog('info', 'Iniciando grabación continua 24/7');

    const rtspUrl = `${config.GO2RTC_RTSP}/c2l_hd`;
    const recDir = config.RECORDINGS_DIR;
    const segmentLen = config.SEGMENT_SECONDS;

    if (!fs.existsSync(recDir)) fs.mkdirSync(recDir, { recursive: true });
    this.ensureDateDirectories(recDir);

    if (this.dateDirInterval) clearInterval(this.dateDirInterval);
    this.dateDirInterval = setInterval(() => {
      this.ensureDateDirectories(recDir);
    }, 30 * 60 * 1000);

    const args = [
      '-hide_banner', '-loglevel', 'warning',
      '-rtsp_transport', 'tcp',
      '-fflags', '+genpts',
      '-i', rtspUrl,
      '-c', 'copy',
      '-avoid_negative_ts', 'make_zero',
      '-f', 'segment',
      '-segment_time', String(segmentLen),
      '-segment_format', 'mp4',
      '-segment_format_options', 'movflags=+faststart',
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
            if (this.mode === 'continuous') this.startContinuous();
          }, 3000);
        }
      });
    } catch (err: any) {
      addLog('error', `Error al iniciar grabación continua: ${err.message}`);
    }
  }

  // ==========================================
  // MOTION-ONLY MODE WITH PRE-ROLL BUFFER
  // ==========================================
  private startMotionMode(): void {
    addLog('info', 'Modo de grabación "Solo Movimiento" activado con buffer pre-roll');
    this.cleanPrerollBuffer();
    this.startPrerollBuffer();

    // Clean up old preroll segments every 5 seconds
    this.prerollCleanupInterval = setInterval(() => {
      this.cleanPrerollBuffer();
    }, 5000);
  }

  private startPrerollBuffer(): void {
    const prerollDir = path.join(config.DATA_DIR, 'preroll');
    if (!fs.existsSync(prerollDir)) fs.mkdirSync(prerollDir, { recursive: true });

    const rtspUrl = `${config.GO2RTC_RTSP}/c2l_hd`;
    // 3-second finalized MP4 segments for pre-roll
    const args = [
      '-hide_banner', '-loglevel', 'warning',
      '-rtsp_transport', 'tcp',
      '-fflags', '+genpts',
      '-i', rtspUrl,
      '-c', 'copy',
      '-avoid_negative_ts', 'make_zero',
      '-f', 'segment',
      '-segment_time', '3',
      '-segment_format', 'mp4',
      '-segment_format_options', 'movflags=+faststart',
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
            if (this.mode === 'motion') this.startPrerollBuffer();
          }, 2000);
        }
      });
    } catch (err: any) {
      addLog('error', `Error al iniciar buffer pre-roll: ${err.message}`);
    }
  }

  private cleanPrerollBuffer(): void {
    try {
      const prerollDir = path.join(config.DATA_DIR, 'preroll');
      if (!fs.existsSync(prerollDir)) return;

      const now = Date.now();
      const files = fs.readdirSync(prerollDir)
        .filter(f => (f.startsWith('pre_') || f.startsWith('active_')) && f.endsWith('.mp4'))
        .map(f => {
          const fullPath = path.join(prerollDir, f);
          try {
            const stat = fs.statSync(fullPath);
            return {
              name: f,
              fullPath,
              size: stat.size,
              mtime: stat.mtimeMs,
            };
          } catch {
            return null;
          }
        })
        .filter((f): f is { name: string; fullPath: string; size: number; mtime: number } => f !== null);

      // Purge stale or corrupted files
      for (const file of files) {
        const isSnapshotLocked = this.prerollSnapshotFiles.includes(file.fullPath);
        const isActiveLiveLocked = this.activeMotionFile === file.fullPath;
        if (isSnapshotLocked || isActiveLiveLocked) continue;

        // Delete any file older than 45 seconds (camera GOP is ~15s) or empty/corrupt after 6s
        const isStale = (now - file.mtime) > 45000;
        const isCorrupt = file.size < 1000 && (now - file.mtime) > 6000;
        if (isStale || isCorrupt) {
          try { fs.unlinkSync(file.fullPath); } catch {}
        }
      }

      // Keep only the most recent N pre-roll segments
      const validPreFiles = files
        .filter(f => f.name.startsWith('pre_') && f.size >= 1000 && (now - f.mtime) <= 45000)
        .sort((a, b) => b.mtime - a.mtime);

      const maxKeep = Math.ceil(config.PREROLL_S / 3) + 1;
      if (validPreFiles.length > maxKeep) {
        for (let i = maxKeep; i < validPreFiles.length; i++) {
          try {
            if (!this.prerollSnapshotFiles.includes(validPreFiles[i].fullPath)) {
              fs.unlinkSync(validPreFiles[i].fullPath);
            }
          } catch {}
        }
      }
    } catch {}
  }

  private handleMotionStart(): void {
    if (this.mode !== 'motion') return;
    this.isMotionActive = true;

    if (this.postrollTimer) {
      clearTimeout(this.postrollTimer);
      this.postrollTimer = null;
    }

    if (!this.isRecordingMotion) {
      this.beginMotionRecording();
    }
  }

  private handleMotionActive(): void {
    if (this.mode !== 'motion') return;
    this.isMotionActive = true;
    if (this.postrollTimer) {
      clearTimeout(this.postrollTimer);
      this.postrollTimer = null;
    }
  }

  private handleMotionEnd(): void {
    if (this.mode !== 'motion') return;
    this.isMotionActive = false;

    if (this.isRecordingMotion && !this.postrollTimer) {
      const postrollMs = config.POSTROLL_S * 1000;
      addLog('info', `Esperando post-roll de ${config.POSTROLL_S}s antes de finalizar clip de movimiento...`);
      this.postrollTimer = setTimeout(() => {
        this.finalizeMotionRecording();
      }, postrollMs);
    }
  }

  private beginMotionRecording(): void {
    this.isRecordingMotion = true;
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const dateDir = path.join(config.RECORDINGS_DIR, dateStr);
    if (!fs.existsSync(dateDir)) fs.mkdirSync(dateDir, { recursive: true });

    const timestampStr = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const targetFile = path.join(dateDir, `c2l_${timestampStr}.mp4`);
    this.activeMotionTarget = targetFile;

    // Snapshot finalized pre-roll files (strictly 3.2s..30s old so the actively written segment is excluded)
    const prerollDir = path.join(config.DATA_DIR, 'preroll');
    let preFiles: string[] = [];
    try {
      const nowMs = Date.now();
      preFiles = fs.readdirSync(prerollDir)
        .filter(f => f.startsWith('pre_') && f.endsWith('.mp4'))
        .map(f => {
          const full = path.join(prerollDir, f);
          try {
            const stat = fs.statSync(full);
            return { full, size: stat.size, mtime: stat.mtimeMs };
          } catch {
            return null;
          }
        })
        .filter((f): f is { full: string; size: number; mtime: number } =>
          f !== null && f.size >= 1000 && (nowMs - f.mtime) >= 2500 && (nowMs - f.mtime) < 45000
        )
        .sort((a, b) => a.mtime - b.mtime)
        .map(f => f.full);

      // Take the last N finalized segments
      const maxPre = Math.ceil(config.PREROLL_S / 3);
      if (preFiles.length > maxPre) {
        preFiles = preFiles.slice(preFiles.length - maxPre);
      }
    } catch {}
    this.prerollSnapshotFiles = [...preFiles];

    // Live segment to capture
    const tempLiveFile = path.join(prerollDir, `active_${timestampStr}.mp4`);
    this.activeMotionFile = tempLiveFile;

    const rtspUrl = `${config.GO2RTC_RTSP}/c2l_hd`;
    const args = [
      '-hide_banner', '-loglevel', 'warning',
      '-rtsp_transport', 'tcp',
      '-fflags', '+genpts',
      '-i', rtspUrl,
      '-c', 'copy',
      '-avoid_negative_ts', 'make_zero',
      '-movflags', '+faststart',
      tempLiveFile,
    ];

    addLog('info', `Iniciando captura de segmento por movimiento: ${path.basename(targetFile)} (preroll: ${preFiles.length} clips)`);

    try {
      this.motionRecordProcess = spawn(config.FFMPEG_PATH, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this.motionRecordProcess.on('exit', () => {
        this.motionRecordProcess = null;
      });
    } catch (err: any) {
      addLog('error', `Error al iniciar captura de movimiento: ${err.message}`);
    }
  }

  private async finalizeMotionRecording(): Promise<void> {
    if (!this.isRecordingMotion) return;
    this.postrollTimer = null;
    this.isRecordingMotion = false;

    const liveFile = this.activeMotionFile;
    const targetFile = this.activeMotionTarget;
    const preFiles = [...this.prerollSnapshotFiles];

    const proc = this.motionRecordProcess;
    this.motionRecordProcess = null;

    if (proc) {
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve();
        };
        const safetyTimeout = setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch {}
          finish();
        }, 8000);

        proc.once('exit', () => {
          clearTimeout(safetyTimeout);
          finish();
        });

        try {
          proc.kill('SIGINT');
        } catch {
          clearTimeout(safetyTimeout);
          finish();
        }
      });
    } else {
      await new Promise((r) => setTimeout(r, 500));
    }

    if (!targetFile) return;

    try {
      const now = Date.now();
      const validPre = preFiles.filter(f => {
        try {
          const stat = fs.statSync(f);
          return stat.size >= 1000 && (now - stat.mtimeMs) < 60000;
        } catch {
          return false;
        }
      });
      const hasLive = liveFile && fs.existsSync(liveFile) && fs.statSync(liveFile).size >= 1000;

      if (!hasLive && validPre.length === 0) {
        addLog('warn', 'No se generaron datos para el clip de movimiento');
        return;
      }

      const allValid = [...validPre, ...(hasLive && liveFile ? [liveFile] : [])];
      if (allValid.length === 1) {
        // Just move the single valid file directly
        const single = allValid[0];
        fs.renameSync(single, targetFile);
      } else if (hasLive && liveFile && validPre.length > 0) {
        // Concat files using ffmpeg concat demuxer with timestamp regeneration
        const allFiles = [...validPre, liveFile];
        const listFile = path.join(config.DATA_DIR, 'preroll', `concat_${Date.now()}.txt`);
        const content = allFiles.map(f => `file '${f}'`).join('\n');
        fs.writeFileSync(listFile, content, 'utf8');

        try {
          await new Promise<void>((resolve, reject) => {
            const concatProc = spawn(config.FFMPEG_PATH, [
              '-hide_banner', '-loglevel', 'warning',
              '-f', 'concat',
              '-safe', '0',
              '-i', listFile,
              '-c', 'copy',
              '-avoid_negative_ts', 'make_zero',
              '-fflags', '+genpts',
              '-movflags', '+faststart',
              '-y',
              targetFile,
            ]);

            concatProc.on('exit', (code) => {
              try { fs.unlinkSync(listFile); } catch {}
              if (code === 0) resolve();
              else reject(new Error(`Concat exited with code ${code}`));
            });
            concatProc.on('error', (err) => {
              try { fs.unlinkSync(listFile); } catch {}
              reject(err);
            });
          });
        } catch (concatErr: any) {
          addLog('warn', `Concat de pre-roll falló (${concatErr.message}); usando archivo principal en vivo`);
          if (fs.existsSync(liveFile)) {
            fs.renameSync(liveFile, targetFile);
          }
        }
      } else if (hasLive && liveFile) {
        fs.renameSync(liveFile, targetFile);
      }

      // Cleanup temp live file if still present
      if (liveFile && fs.existsSync(liveFile)) {
        try { fs.unlinkSync(liveFile); } catch {}
      }

      if (fs.existsSync(targetFile)) {
        const stat = fs.statSync(targetFile);
        addLog('info', `Clip de movimiento guardado: ${path.basename(targetFile)} (${Math.round(stat.size / 1024 / 1024 * 10) / 10} MB)`);
      }
    } catch (err: any) {
      addLog('error', `Error finalizando grabación de movimiento: ${err.message}`);
    } finally {
      this.activeMotionFile = null;
      this.activeMotionTarget = null;
      this.prerollSnapshotFiles = [];
    }
  }
}

let instance: RecorderManager | null = null;

export function getRecorderManager(): RecorderManager {
  if (!instance) {
    instance = new RecorderManager();
  }
  return instance;
}

export function initRecorderManager(): RecorderManager {
  const mgr = getRecorderManager();
  mgr.init();
  return mgr;
}
