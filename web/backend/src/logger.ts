import fs from 'fs';
import path from 'path';
import { config } from './config.js';

export interface LogEntry {
  id: string;
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  details?: Record<string, unknown> | string;
}

const memoryLogs: LogEntry[] = [];
const MAX_MEMORY_LOGS = 200;

const logFile = path.join(config.DATA_DIR, 'nvr.log');

// Ensure data dir exists
if (!fs.existsSync(config.DATA_DIR)) {
  fs.mkdirSync(config.DATA_DIR, { recursive: true });
}

export function addLog(level: 'info' | 'warn' | 'error', message: string, details?: Record<string, unknown> | string) {
  const entry: LogEntry = {
    id: `${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    timestamp: new Date().toISOString(),
    level,
    message,
    details,
  };

  memoryLogs.unshift(entry);
  if (memoryLogs.length > MAX_MEMORY_LOGS) {
    memoryLogs.pop();
  }

  const logLine = `[${entry.timestamp}] [${level.toUpperCase()}] ${message}${details ? ' ' + JSON.stringify(details) : ''}\n`;
  try {
    fs.appendFileSync(logFile, logLine, 'utf8');
  } catch (err) {
    console.error('Failed to write to log file:', err);
  }

  if (level === 'error') {
    console.error(`[NVR ERROR] ${message}`, details || '');
  } else if (level === 'warn') {
    console.warn(`[NVR WARN] ${message}`, details || '');
  } else {
    console.log(`[NVR INFO] ${message}`);
  }
}

export function getLogs(limit = 50): LogEntry[] {
  return memoryLogs.slice(0, Math.min(limit, memoryLogs.length));
}
