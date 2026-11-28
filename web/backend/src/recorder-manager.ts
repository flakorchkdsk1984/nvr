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
  private lockedFiles = new Set<string>();
  private postrollTimer: NodeJS.Timeout | null = null;
  private isMotionActive = false;
  private isRecordingMotion = false;
  private prerollCleanupInterval: NodeJS.Timeout | null = null;
  private dateDirInterval: NodeJS.Timeout | null = null;
  private lastStderrLogAt = new Map<string, number>();
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

  /**
   * Drains stdout/stderr pipes continuously so FFmpeg never deadlocks on a full 64KB kernel pipe buffer,
   * while throttling error logging to avoid log flooding.
   */
  private attachPipeDrain(proc: ChildProcess, label: string): void {
    proc.stdout?.on('data', () => {});
    proc.stderr?.on('data', (chunk: Buffer) => {
      const msg = chunk.toString('utf8').trim();
      if (!msg) return;
      // Ignore noisy non-fatal packet timestamp notice; log real errors throttled every 30s
      if (msg.includes('Timestamps are unset in a packet')) return;
      const now = Date.now();
      const prev = this.lastStderrLogAt.get(label) || 0;
      if (now - prev > 30000) {
        this.lastStderrLogAt.set(label, now);
        addLog('warn', `FFmpeg [${label}]: ${msg.slice(0, 220)}`);
      }
    });
  }

  public init(): void {
    if (this.initialized) return;
    this.initialized = true;

    const prerollDir = path.join(config.DATA_DIR, 'preroll');
    if (!fs.existsSync(prerollDir)) fs.mkdirSync(prerollDir, { recursive: true });

    const motionEngine = getMotionEngine();
    motionEngine.on('motion-start', () => this.handleMotionStart());
    motionEngine.on('motion-active', () => this.handleMotionActive());
    motionEngine.on('motion-end', () => this.handleMotionEnd());

    this.applyMode(this.mode);
  }

  public getStatus(): RecorderStatus {
    const prerollDir = path.join(config.DATA_DIR, 'preroll');
    let prerollCount = 0;
    try {
      if (fs.existsSync(prerollDir)) {
        prerollCount = fs.readdirSync(prerollDir).filter(f => f.startsWith('pre_') && (f.endsWith('.ts') || f.endsWith('.mp4'))).length;
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

  private ensureDateDirectories(recDir: string): boolean {
    let createdToday = false;
    const pad = (n: number) => String(n).padStart(2, '0');
    for (const offsetDays of [0, 1]) {
      const d = new Date(Date.now() + offsetDays * 86400000);
      const dateFolder = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      const full = path.join(recDir, dateFolder);
      if (!fs.existsSync(full)) {
        fs.mkdirSync(full, { recursive: true });
        if (offsetDays === 0) createdToday = true;
      }
    }
    return createdToday;
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
      const recreatedToday = this.ensureDateDirectories(recDir);
      if (recreatedToday && this.mode === 'continuous' && this.continuousProcess) {
        addLog('warn', 'Carpeta del día actual recreada; reiniciando segmento continuo FFmpeg...');
        try { this.continuousProcess.kill('SIGTERM'); } catch {}
      }
    }, 15 * 1000);

    const args = [
      '-hide_banner', '-loglevel', 'warning',
      '-rtsp_transport', 'tcp',
      '-fflags', '+genpts',
      '-i', rtspUrl,
      '-c', 'copy',
      '-avoid_negative_ts', 'make_zero',
      '-video_track_timescale', '90000',
      '-f', 'segment',
      '-segment_time', String(segmentLen),
      '-segment_format', 'mp4',
      '-segment_format_options', 'movflags=+faststart',
      '-reset_timestamps', '1',
      '-strftime', '1',
      path.join(recDir, '%Y-%m-%d', 'c2l_%Y%m%d_%H%M%S.mp4'),
    ];

    try {
      const proc = spawn(config.FFMPEG_PATH, args, {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      this.continuousProcess = proc;
      this.attachPipeDrain(proc, 'continuous');

      proc.on('exit', (code) => {
        if (this.continuousProcess === proc) {
          this.continuousProcess = null;
        }
        if (this.mode === 'continuous') {
          addLog('warn', `Proceso FFmpeg continuo finalizó (${code}). Reiniciando en 3s...`);
          setTimeout(() => {
            if (this.mode === 'continuous' && !this.continuousProcess) this.startContinuous();
          }, 3000);
        }
      });
    } catch (err: any) {
      addLog('error', `Error al iniciar grabación continua: ${err.message}`);
    }
  }

  // ==========================================
  // MOTION-ONLY MODE WITH MPEG-TS PRE-ROLL BUFFER
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
    // 3-second MPEG-TS segments for pre-roll: fixed 90kHz PTS, no trailer needed on split
    const args = [
      '-hide_banner', '-loglevel', 'warning',
      '-rtsp_transport', 'tcp',
      '-fflags', '+genpts',
      '-i', rtspUrl,
      '-c', 'copy',
      '-f', 'segment',
      '-segment_time', '3',
      '-segment_format', 'mpegts',
      '-reset_timestamps', '1',
      '-strftime', '1',
      path.join(prerollDir, 'pre_%Y%m%d_%H%M%S.ts'),
    ];

    try {
      const proc = spawn(config.FFMPEG_PATH, args, {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      this.prerollProcess = proc;
      this.attachPipeDrain(proc, 'preroll');

      proc.on('exit', () => {
        if (this.prerollProcess === proc) {
          this.prerollProcess = null;
        }
        if (this.mode === 'motion') {
          setTimeout(() => {
            if (this.mode === 'motion' && !this.prerollProcess) this.startPrerollBuffer();
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
        .filter(f => (f.startsWith('pre_') || f.startsWith('active_')) && (f.endsWith('.ts') || f.endsWith('.mp4')))
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

      for (const file of files) {
        if (
          this.lockedFiles.has(file.fullPath) ||
          this.prerollSnapshotFiles.includes(file.fullPath) ||
          this.activeMotionFile === file.fullPath
        ) {
          continue;
        }

        const isLegacyMp4 = file.name.endsWith('.mp4');
        const isStale = (now - file.mtime) > 45000;
        const isCorrupt = file.size < 1000 && (now - file.mtime) > 6000;
        if (isLegacyMp4 || isStale || isCorrupt) {
          try { fs.unlinkSync(file.fullPath); } catch {}
        }
      }

      const validPreFiles = files
        .filter(f => f.name.startsWith('pre_') && f.name.endsWith('.ts') && f.size >= 1000 && (now - f.mtime) <= 45000)
        .sort((a, b) => b.mtime - a.mtime);

      const maxKeep = Math.ceil(config.PREROLL_S / 3) + 1;
      if (validPreFiles.length > maxKeep) {
        for (let i = maxKeep; i < validPreFiles.length; i++) {
          const p = validPreFiles[i].fullPath;
          if (!this.lockedFiles.has(p) && !this.prerollSnapshotFiles.includes(p)) {
            try { fs.unlinkSync(p); } catch {}
          }
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

    // Snapshot finalized pre-roll MPEG-TS files (exclude newest open file modified within 2.5s)
    const prerollDir = path.join(config.DATA_DIR, 'preroll');
    let preFiles: string[] = [];
    try {
      const nowMs = Date.now();
      preFiles = fs.readdirSync(prerollDir)
        .filter(f => f.startsWith('pre_') && f.endsWith('.ts'))
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

      const maxPre = Math.ceil(config.PREROLL_S / 3);
      if (preFiles.length > maxPre) {
        preFiles = preFiles.slice(preFiles.length - maxPre);
      }
    } catch {}
    this.prerollSnapshotFiles = [...preFiles];

    // Live segment captured as MPEG-TS so packets flush immediately without buffered moov
    const tempLiveFile = path.join(prerollDir, `active_${timestampStr}.ts`);
    this.activeMotionFile = tempLiveFile;

    const rtspUrl = `${config.GO2RTC_RTSP}/c2l_hd`;
    const args = [
      '-hide_banner', '-loglevel', 'warning',
      '-rtsp_transport', 'tcp',
      '-fflags', '+genpts',
      '-i', rtspUrl,
      '-c', 'copy',
      '-f', 'mpegts',
      tempLiveFile,
    ];

    addLog('info', `Iniciando captura de segmento por movimiento: ${path.basename(targetFile)} (preroll: ${preFiles.length} clips)`);

    try {
      const proc = spawn(config.FFMPEG_PATH, args, {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      this.motionRecordProcess = proc;
      this.attachPipeDrain(proc, 'motion-record');

      proc.on('exit', () => {
        if (this.motionRecordProcess === proc) {
          this.motionRecordProcess = null;
        }
      });
    } catch (err: any) {
      addLog('error', `Error al iniciar captura de movimiento: ${err.message}`);
    }
  }

  private async remuxTsToMp4(inputFiles: string[], targetFile: string): Promise<void> {
    const targetDir = path.dirname(targetFile);
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    // Write temporary MP4 inside targetDir so final renameSync is guaranteed same-filesystem (never EXDEV)
    const tempOutMp4 = `${targetFile}.tmp.mp4`;

    let ffmpegArgs: string[];
    let listFile: string | null = null;

    if (inputFiles.length === 1) {
      ffmpegArgs = [
        '-hide_banner', '-loglevel', 'warning',
        '-fflags', '+genpts',
        '-i', inputFiles[0],
        '-c', 'copy',
        '-avoid_negative_ts', 'make_zero',
        '-video_track_timescale', '90000',
        '-movflags', '+faststart',
        '-y',
        tempOutMp4,
      ];
    } else {
      listFile = path.join(config.DATA_DIR, 'preroll', `concat_${Date.now()}_${Math.floor(Math.random() * 1000)}.txt`);
      fs.writeFileSync(listFile, inputFiles.map(f => `file '${f}'`).join('\n'), 'utf8');
      ffmpegArgs = [
        '-hide_banner', '-loglevel', 'warning',
        '-f', 'concat',
        '-safe', '0',
        '-i', listFile,
        '-c', 'copy',
        '-avoid_negative_ts', 'make_zero',
        '-fflags', '+genpts',
        '-video_track_timescale', '90000',
        '-movflags', '+faststart',
        '-y',
        tempOutMp4,
      ];
    }

    await new Promise<void>((resolve, reject) => {
      const remuxProc = spawn(config.FFMPEG_PATH, ffmpegArgs, {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let errBuf = '';
      remuxProc.stderr?.on('data', (d: Buffer) => {
        errBuf += d.toString('utf8');
      });

      remuxProc.on('exit', (code) => {
        if (listFile) try { fs.unlinkSync(listFile); } catch {}
        if (code === 0 && fs.existsSync(tempOutMp4) && fs.statSync(tempOutMp4).size > 1000) {
          fs.renameSync(tempOutMp4, targetFile);
          resolve();
        } else {
          if (fs.existsSync(tempOutMp4)) try { fs.unlinkSync(tempOutMp4); } catch {}
          reject(new Error(`Remux exited with code ${code}: ${errBuf.slice(0, 180)}`));
        }
      });
      remuxProc.on('error', (err) => {
        if (listFile) try { fs.unlinkSync(listFile); } catch {}
        if (fs.existsSync(tempOutMp4)) try { fs.unlinkSync(tempOutMp4); } catch {}
        reject(err);
      });
    });
  }

  private async finalizeMotionRecording(): Promise<void> {
    if (!this.isRecordingMotion) return;
    this.postrollTimer = null;
    this.isRecordingMotion = false;

    // Snapshot references and clear instance fields immediately so overlapping events never collide
    const liveFile = this.activeMotionFile;
    const targetFile = this.activeMotionTarget;
    const preFiles = [...this.prerollSnapshotFiles];
    const proc = this.motionRecordProcess;

    this.activeMotionFile = null;
    this.activeMotionTarget = null;
    this.prerollSnapshotFiles = [];
    this.motionRecordProcess = null;

    const lockedPaths = [...preFiles, ...(liveFile ? [liveFile] : [])];
    for (const p of lockedPaths) this.lockedFiles.add(p);

    try {
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
          }, 5000);

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
        await new Promise((r) => setTimeout(r, 400));
      }

      if (!targetFile) return;

      const now = Date.now();
      const validPre = preFiles.filter(f => {
        try {
          const stat = fs.statSync(f);
          return stat.size >= 1000 && (now - stat.mtimeMs) < 90000;
        } catch {
          return false;
        }
      });
      const hasLive = !!(liveFile && fs.existsSync(liveFile) && fs.statSync(liveFile).size >= 1000);

      if (!hasLive && validPre.length === 0) {
        addLog('warn', 'No se generaron datos para el clip de movimiento');
        return;
      }

      const allValid = [...validPre, ...(hasLive && liveFile ? [liveFile] : [])];
      try {
        await this.remuxTsToMp4(allValid, targetFile);
      } catch (concatErr: any) {
        if (hasLive && liveFile && validPre.length > 0) {
          addLog('warn', `Concat de pre-roll falló (${concatErr.message}); remuxando solo captura en vivo`);
          await this.remuxTsToMp4([liveFile], targetFile);
        } else {
          throw concatErr;
        }
      }

      if (fs.existsSync(targetFile)) {
        const stat = fs.statSync(targetFile);
        addLog('info', `Clip de movimiento guardado: ${path.basename(targetFile)} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
      }
    } catch (err: any) {
      addLog('error', `Error finalizando grabación de movimiento: ${err.message}`);
    } finally {
      if (liveFile && fs.existsSync(liveFile)) {
        try { fs.unlinkSync(liveFile); } catch {}
      }
      for (const p of lockedPaths) this.lockedFiles.delete(p);
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
