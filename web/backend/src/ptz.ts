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
  action: z.enum(['goto', 'set', 'meta']),
  number: z.number().int().min(1).max(6),
  name: z.string().max(40).optional(),
  emoji: z.string().max(16).optional(),
});

export const PtzConfigSchema = z.object({
  speed: z.number().int().min(1).max(8),
  continuous: z.boolean(),
});

export interface PtzConfig {
  speed: number;
  continuous: boolean;
  updatedAt?: string;
}

export interface PtzMetrics {
  lastLatencyMs: number | null;
  avgLatencyMs: number | null;
  minLatencyMs: number | null;
  maxLatencyMs: number | null;
  totalCommands: number;
  successCount: number;
  failCount: number;
  coalescedCount: number;
  queueDepth: number;
  inFlight: boolean;
  lastAction: string | null;
  lastSuccess: boolean | null;
  lastError: string | null;
  lastUpdatedAt: string | null;
}

export interface PresetInfo {
  number: number;
  name: string;
  emoji?: string;
  updatedAt?: string;
}

const presetsFile = path.join(config.DATA_DIR, 'presets.json');
const ptzConfigFile = path.join(config.DATA_DIR, 'ptz-config.json');
const MAX_PRESETS = 6;

function loadPresets(): Record<number, PresetInfo> {
  try {
    if (fs.existsSync(presetsFile)) {
      const data = JSON.parse(fs.readFileSync(presetsFile, 'utf8'));
      return data;
    }
  } catch (err) {
    addLog('error', 'Failed to read presets file', String(err));
  }
  const defaultPresets: Record<number, PresetInfo> = {};
  for (let i = 1; i <= MAX_PRESETS; i++) {
    defaultPresets[i] = { number: i, name: `Preset ${i}`, emoji: '🎯' };
  }
  return defaultPresets;
}

function savePresets(presets: Record<number, PresetInfo>) {
  try {
    fs.writeFileSync(presetsFile, JSON.stringify(presets, null, 2), 'utf8');
  } catch (err) {
    addLog('error', 'Failed to save presets file', String(err));
  }
}

export function getPtzConfig(): PtzConfig {
  try {
    if (fs.existsSync(ptzConfigFile)) {
      const raw = JSON.parse(fs.readFileSync(ptzConfigFile, 'utf8'));
      const parsed = PtzConfigSchema.safeParse(raw);
      if (parsed.success) {
        return {
          ...parsed.data,
          ...(typeof raw.updatedAt === 'string' ? { updatedAt: raw.updatedAt } : {}),
        };
      }
    }
  } catch (err) {
    addLog('error', 'Failed to read PTZ config file', String(err));
  }
  return { speed: 5, continuous: false };
}

export function savePtzConfig(input: z.infer<typeof PtzConfigSchema>): PtzConfig {
  const next: PtzConfig = {
    speed: input.speed,
    continuous: input.continuous,
    updatedAt: new Date().toISOString(),
  };
  try {
    if (!fs.existsSync(config.DATA_DIR)) {
      fs.mkdirSync(config.DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(ptzConfigFile, JSON.stringify(next, null, 2), 'utf8');
  } catch (err) {
    addLog('error', 'Failed to save PTZ config file', String(err));
  }
  return next;
}

// Single-flight serialized PTZ CGI queue with latest-move coalescing & metrics
interface CgiResult {
  success: boolean;
  status: number;
  message: string;
  latencyMs: number;
  coalesced?: boolean;
  metrics?: PtzMetrics;
}

interface PendingTask {
  actionLabel: string;
  endpoint: string;
  timeoutMs: number;
  resolve: (res: CgiResult) => void;
}

let cgiRunning = false;
let pendingMove: PendingTask | null = null;
const criticalQueue: PendingTask[] = [];

const recentLatencies: number[] = [];
const metricsState = {
  lastLatencyMs: null as number | null,
  minLatencyMs: null as number | null,
  maxLatencyMs: null as number | null,
  totalCommands: 0,
  successCount: 0,
  failCount: 0,
  coalescedCount: 0,
  lastAction: null as string | null,
  lastSuccess: null as boolean | null,
  lastError: null as string | null,
  lastUpdatedAt: null as string | null,
};

export function getPtzMetrics(): PtzMetrics {
  const avg =
    recentLatencies.length > 0
      ? Math.round(recentLatencies.reduce((acc, v) => acc + v, 0) / recentLatencies.length)
      : null;
  return {
    lastLatencyMs: metricsState.lastLatencyMs,
    avgLatencyMs: avg,
    minLatencyMs: metricsState.minLatencyMs,
    maxLatencyMs: metricsState.maxLatencyMs,
    totalCommands: metricsState.totalCommands,
    successCount: metricsState.successCount,
    failCount: metricsState.failCount,
    coalescedCount: metricsState.coalescedCount,
    queueDepth: criticalQueue.length + (pendingMove ? 1 : 0),
    inFlight: cgiRunning,
    lastAction: metricsState.lastAction,
    lastSuccess: metricsState.lastSuccess,
    lastError: metricsState.lastError,
    lastUpdatedAt: metricsState.lastUpdatedAt,
  };
}

function recordCgiMetric(actionLabel: string, result: CgiResult) {
  metricsState.totalCommands++;
  metricsState.lastAction = actionLabel;
  metricsState.lastLatencyMs = result.latencyMs;
  metricsState.lastSuccess = result.success;
  metricsState.lastUpdatedAt = new Date().toISOString();

  if (result.success) {
    metricsState.successCount++;
    metricsState.lastError = null;
  } else {
    metricsState.failCount++;
    metricsState.lastError = result.message;
  }

  recentLatencies.push(result.latencyMs);
  if (recentLatencies.length > 20) recentLatencies.shift();
  metricsState.minLatencyMs =
    metricsState.minLatencyMs === null ? result.latencyMs : Math.min(metricsState.minLatencyMs, result.latencyMs);
  metricsState.maxLatencyMs =
    metricsState.maxLatencyMs === null ? result.latencyMs : Math.max(metricsState.maxLatencyMs, result.latencyMs);
}

async function drainCgiQueue() {
  if (cgiRunning) return;
  cgiRunning = true;

  try {
    while (criticalQueue.length > 0 || pendingMove !== null) {
      // Critical tasks (stop, presets) always preempt pending coalesced moves
      const task = criticalQueue.length > 0 ? criticalQueue.shift()! : pendingMove!;
      if (task === pendingMove) {
        pendingMove = null;
      }

      const res = await sendCameraCgi(task.endpoint, task.timeoutMs);
      recordCgiMetric(task.actionLabel, res);
      if (!res.success) {
        addLog('warn', `PTZ command failed (${task.actionLabel}) [${res.latencyMs}ms]`, res.message);
      }
      task.resolve({ ...res, metrics: getPtzMetrics() });
    }
  } finally {
    cgiRunning = false;
  }
}

function enqueueCameraCgi(
  actionLabel: string,
  endpoint: string,
  timeoutMs: number,
  coalesceAsMove: boolean
): Promise<CgiResult> {
  return new Promise((resolve) => {
    const task: PendingTask = { actionLabel, endpoint, timeoutMs, resolve };

    if (coalesceAsMove) {
      // Replace any waiting move so bursts never build a stale camera backlog
      if (pendingMove) {
        const superseded = pendingMove;
        metricsState.coalescedCount++;
        superseded.resolve({
          success: true,
          status: 200,
          message: 'Coalesced by newer PTZ move',
          latencyMs: 0,
          coalesced: true,
          metrics: getPtzMetrics(),
        });
      }
      pendingMove = task;
    } else {
      // A stop or preset command supersedes any unstarted move waiting behind it
      if (pendingMove) {
        const superseded = pendingMove;
        pendingMove = null;
        metricsState.coalescedCount++;
        superseded.resolve({
          success: true,
          status: 200,
          message: 'Cancelled by stop/preset',
          latencyMs: 0,
          coalesced: true,
          metrics: getPtzMetrics(),
        });
      }
      criticalQueue.push(task);
    }

    void drainCgiQueue();
  });
}

async function sendCameraCgi(endpoint: string, timeoutMs = 4500): Promise<CgiResult> {
  const url = `http://${config.CAMERA_HOST}:${config.CAMERA_PORT}${endpoint}`;
  const authStr = `${config.CAMERA_USER}:${config.CAMERA_PASS}`;
  const b64Auth = Buffer.from(authStr, 'utf8').toString('base64');
  const start = Date.now();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Basic ${b64Auth}`,
        'Connection': 'close',
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const body = (await res.text()).trim();
    const latencyMs = Date.now() - start;
    if (res.ok) {
      return { success: true, status: res.status, message: body, latencyMs };
    }
    return { success: false, status: res.status, message: body || res.statusText, latencyMs };
  } catch (err: any) {
    clearTimeout(timeoutId);
    const latencyMs = Date.now() - start;
    return {
      success: false,
      status: 0,
      message: err.name === 'AbortError' ? 'Camera request timeout' : err.message,
      latencyMs,
    };
  }
}

export async function executePtzMove(params: z.infer<typeof PtzMoveSchema>) {
  const isStop = params.action === 'stop';
  const endpoint = isStop
    ? '/cgi-bin/hi3510/ptzctrl.cgi?-step=0&-act=stop'
    : `/cgi-bin/hi3510/ptzctrl.cgi?-step=${params.step}&-act=${params.action}&-speed=${params.speed}`;

  return enqueueCameraCgi(params.action, endpoint, isStop ? 3500 : 4000, !isStop);
}

export async function executePtzPreset(params: z.infer<typeof PtzPresetSchema>) {
  if (params.action === 'meta') {
    const presets = loadPresets();
    const existing = presets[params.number];
    const cleanName = params.name?.trim();
    const cleanEmoji = params.emoji?.trim();
    presets[params.number] = {
      number: params.number,
      name: cleanName || existing?.name || `Preset ${params.number}`,
      emoji: cleanEmoji || existing?.emoji || '🎯',
      updatedAt: new Date().toISOString(),
    };
    savePresets(presets);
    addLog('info', `Updated Preset ${params.number} metadata: ${presets[params.number].emoji} ${presets[params.number].name}`);
    return { success: true, status: 200, message: 'Metadata updated', metrics: getPtzMetrics() };
  }

  const endpoint = `/cgi-bin/hi3510/preset.cgi?-status=1&-act=${params.action}&-number=${params.number}`;
  const result = await enqueueCameraCgi(`preset-${params.action}-${params.number}`, endpoint, 8000, false);

  if (result.success) {
    const presets = loadPresets();
    if (params.action === 'set') {
      const existing = presets[params.number];
      const cleanName = params.name?.trim();
      const cleanEmoji = params.emoji?.trim();
      presets[params.number] = {
        number: params.number,
        name: cleanName || existing?.name || `Preset ${params.number}`,
        emoji: cleanEmoji || existing?.emoji || '🎯',
        updatedAt: new Date().toISOString(),
      };
      savePresets(presets);
      addLog('info', `Saved Preset ${params.number}: ${presets[params.number].emoji} ${presets[params.number].name}`);
    }
  }

  return result;
}

export function getPresetsList(): PresetInfo[] {
  const map = loadPresets();
  const list: PresetInfo[] = [];
  for (let i = 1; i <= MAX_PRESETS; i++) {
    const p = map[i];
    list.push({
      number: i,
      name: p?.name || `Preset ${i}`,
      emoji: p?.emoji || '🎯',
      ...(p?.updatedAt ? { updatedAt: p.updatedAt } : {}),
    });
  }
  return list;
}
