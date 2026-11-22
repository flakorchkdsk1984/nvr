import { EventEmitter } from 'events';
import { spawn, ChildProcess } from 'child_process';
import { config } from './config.js';
import { addLog } from './logger.js';
import { getLiveSnapshotBuffer } from './system.js';
import {
  recordMotionStart,
  recordMotionEnd,
  MotionEvent,
} from './events.js';

export interface MotionData {
  active: boolean;
  score: number;
  maxScore: number;
  durationSeconds: number;
  currentEvent: MotionEvent | null;
}

export abstract class MotionSource extends EventEmitter {
  abstract start(): void;
  abstract stop(): void;
  abstract isActive(): boolean;
  abstract getStatus(): MotionData;
}

const FRAME_WIDTH = 64;
const FRAME_HEIGHT = 36;
const FRAME_SIZE = FRAME_WIDTH * FRAME_HEIGHT; // 2,304 bytes
const PIXEL_DELTA_THRESHOLD = 25; // Minimum luminance change to count as a moved pixel

export class SoftwareMotionSource extends MotionSource {
  private ffmpegProcess: ChildProcess | null = null;
  private isRunning = false;
  private inMotion = false;
  private currentEvent: MotionEvent | null = null;
  private currentScore = 0;
  private maxScore = 0;
  private motionStartTime = 0;
  private lastMotionTime = 0;
  private cooldownTimer: NodeJS.Timeout | null = null;
  private frameBuffer: Buffer = Buffer.alloc(0);
  private previousFrame: Buffer | null = null;
  private restartTimeout: NodeJS.Timeout | null = null;
  private restartAttempts = 0;

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    addLog('info', `Iniciando detector de movimiento por software (sensibilidad: ${config.MOTION_SENSITIVITY}%, cooldown: ${config.MOTION_COOLDOWN_S}s)`);
    this.spawnFfmpeg();
  }

  stop(): void {
    this.isRunning = false;
    if (this.restartTimeout) {
      clearTimeout(this.restartTimeout);
      this.restartTimeout = null;
    }
    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }

    if (this.inMotion && this.currentEvent) {
      const finished = recordMotionEnd(this.currentEvent.id, this.maxScore);
      this.inMotion = false;
      this.emit('motion-end', finished);
      this.currentEvent = null;
    }

    if (this.ffmpegProcess) {
      try {
        this.ffmpegProcess.kill('SIGTERM');
      } catch {}
      this.ffmpegProcess = null;
    }
    this.frameBuffer = Buffer.alloc(0);
    this.previousFrame = null;
    addLog('info', 'Detector de movimiento detenido');
  }

  isActive(): boolean {
    return this.inMotion;
  }

  getStatus(): MotionData {
    const duration = this.inMotion && this.motionStartTime > 0
      ? Math.round((Date.now() - this.motionStartTime) / 1000)
      : 0;

    return {
      active: this.inMotion,
      score: this.currentScore,
      maxScore: this.maxScore,
      durationSeconds: duration,
      currentEvent: this.currentEvent,
    };
  }

  private spawnFfmpeg(): void {
    if (!this.isRunning) return;

    // Use RTSP sub-stream SD: rtsp://127.0.0.1:8554/c2l_sd
    const rtspUrl = `${config.GO2RTC_RTSP}/c2l_sd`;
    const args = [
      '-loglevel', 'warning',
      '-rtsp_transport', 'tcp',
      '-i', rtspUrl,
      '-vf', `fps=2,scale=${FRAME_WIDTH}:${FRAME_HEIGHT},format=gray`,
      '-f', 'rawvideo',
      '-',
    ];

    try {
      this.ffmpegProcess = spawn(config.FFMPEG_PATH, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this.ffmpegProcess.stdout?.on('data', (chunk: Buffer) => {
        this.handleData(chunk);
      });

      this.ffmpegProcess.stderr?.on('data', () => {
        // Suppress or selectively log ffmpeg warnings
      });

      this.ffmpegProcess.on('exit', (code) => {
        this.ffmpegProcess = null;
        if (this.isRunning) {
          const delay = Math.min(10000, 2000 * Math.pow(1.5, Math.min(this.restartAttempts++, 5)));
          addLog('warn', `Detector FFmpeg finalizó con código ${code}. Reconectando en ${Math.round(delay / 1000)}s...`);
          this.restartTimeout = setTimeout(() => {
            this.spawnFfmpeg();
          }, delay);
        }
      });

      this.ffmpegProcess.on('error', (err) => {
        addLog('error', `Error en proceso FFmpeg de movimiento: ${err.message}`);
      });

      this.restartAttempts = 0;
    } catch (err: any) {
      addLog('error', `No se pudo iniciar el proceso de detección: ${err.message}`);
    }
  }

  private handleData(chunk: Buffer): void {
    this.frameBuffer = Buffer.concat([this.frameBuffer, chunk]);

    while (this.frameBuffer.length >= FRAME_SIZE) {
      const frame = this.frameBuffer.subarray(0, FRAME_SIZE);
      this.frameBuffer = this.frameBuffer.subarray(FRAME_SIZE);
      this.processFrame(frame);
    }
  }

  private processFrame(currentFrame: Buffer): void {
    if (!this.previousFrame) {
      this.previousFrame = Buffer.from(currentFrame);
      return;
    }

    let changedPixels = 0;
    for (let i = 0; i < FRAME_SIZE; i++) {
      if (Math.abs(currentFrame[i] - this.previousFrame[i]) > PIXEL_DELTA_THRESHOLD) {
        changedPixels++;
      }
    }

    // Save copy of current frame for next diff
    this.previousFrame = Buffer.from(currentFrame);

    const score = Math.round((changedPixels / FRAME_SIZE) * 1000) / 10; // e.g. 4.2%
    this.currentScore = score;

    const threshold = config.MOTION_SENSITIVITY;

    if (score >= threshold) {
      this.lastMotionTime = Date.now();
      if (!this.inMotion) {
        this.triggerMotionStart(score);
      } else {
        this.maxScore = Math.max(this.maxScore, score);
        this.emit('motion-active', {
          score,
          maxScore: this.maxScore,
          currentEvent: this.currentEvent,
        });
        this.resetCooldownTimer();
      }
    } else if (this.inMotion) {
      // Below threshold, let cooldown timer handle ending the event
      if (!this.cooldownTimer) {
        this.resetCooldownTimer();
      }
    }
  }

  private async triggerMotionStart(score: number): Promise<void> {
    this.inMotion = true;
    this.motionStartTime = Date.now();
    this.lastMotionTime = Date.now();
    this.maxScore = score;

    let snapshotBuf: Buffer | undefined;
    try {
      const snap = await getLiveSnapshotBuffer();
      snapshotBuf = snap.buffer;
    } catch {
      // Snapshot optional
    }

    const event = recordMotionStart('software', score, snapshotBuf);
    this.currentEvent = event;

    addLog('info', `Detección de movimiento INICIADA (Score: ${score}%, Evento #${event.id})`);
    this.emit('motion-start', event);

    this.resetCooldownTimer();
  }

  private resetCooldownTimer(): void {
    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer);
    }

    const cooldownMs = config.MOTION_COOLDOWN_S * 1000;
    this.cooldownTimer = setTimeout(() => {
      this.checkMotionEnd();
    }, cooldownMs);
  }

  private checkMotionEnd(): void {
    const elapsedSinceLastMotion = Date.now() - this.lastMotionTime;
    const cooldownMs = config.MOTION_COOLDOWN_S * 1000;

    if (elapsedSinceLastMotion >= cooldownMs && this.inMotion) {
      if (this.currentEvent) {
        const finished = recordMotionEnd(this.currentEvent.id, this.maxScore);
        addLog('info', `Detección de movimiento FINALIZADA (Evento #${this.currentEvent.id}, Duración: ${finished?.duration_s}s, Max Score: ${this.maxScore}%)`);
        this.emit('motion-end', finished);
      }
      this.inMotion = false;
      this.currentEvent = null;
      this.maxScore = 0;
      this.cooldownTimer = null;
    }
  }
}

export class CameraMotionSource extends MotionSource {
  private isRunning = false;

  start(): void {
    this.isRunning = true;
    addLog('warn', 'Fuente de movimiento nativa de cámara seleccionada (la cámara actual no expone CGI de movimiento; usando modo pasivo)');
  }

  stop(): void {
    this.isRunning = false;
  }

  isActive(): boolean {
    return false;
  }

  getStatus(): MotionData {
    return {
      active: false,
      score: 0,
      maxScore: 0,
      durationSeconds: 0,
      currentEvent: null,
    };
  }
}

let activeMotionEngine: MotionSource | null = null;

export function getMotionEngine(): MotionSource {
  if (activeMotionEngine) return activeMotionEngine;

  if (config.MOTION_SOURCE === 'camera') {
    activeMotionEngine = new CameraMotionSource();
  } else {
    activeMotionEngine = new SoftwareMotionSource();
  }

  return activeMotionEngine;
}

export function startMotionEngine(): MotionSource {
  const engine = getMotionEngine();
  engine.start();
  return engine;
}

export function stopMotionEngine(): void {
  if (activeMotionEngine) {
    activeMotionEngine.stop();
  }
}
