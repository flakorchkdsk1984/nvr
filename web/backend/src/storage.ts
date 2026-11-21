import fs from 'fs';
import path from 'path';
import { config } from './config.js';
import { addLog } from './logger.js';
import { DATE_REGEX, FILE_REGEX } from './recordings.js';

export interface StorageStats {
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  percentUsed: number;
  recordingsSizeBytes: number;
  totalSegments: number;
  effectiveRetentionDays: number;
  avgDailyBytes: number;
  retentionTargetDays: number;
}

export function getStorageStats(): StorageStats {
  let totalBytes = 0;
  let freeBytes = 0;
  let usedBytes = 0;
  let percentUsed = 0;

  try {
    const stat = fs.statfsSync(config.RECORDINGS_DIR);
    totalBytes = stat.blocks * stat.bsize;
    freeBytes = stat.bavail * stat.bsize;
    usedBytes = totalBytes - freeBytes;
    percentUsed = totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0;
  } catch (err) {
    addLog('error', 'Failed to read filesystem stats', String(err));
  }

  let recordingsSizeBytes = 0;
  let totalSegments = 0;
  const daysSet = new Set<string>();

  if (fs.existsSync(config.RECORDINGS_DIR)) {
    const dates = fs.readdirSync(config.RECORDINGS_DIR);
    for (const d of dates) {
      if (!DATE_REGEX.test(d)) continue;
      daysSet.add(d);
      const dPath = path.join(config.RECORDINGS_DIR, d);
      try {
        const files = fs.readdirSync(dPath);
        for (const f of files) {
          if (!FILE_REGEX.test(f)) continue;
          totalSegments++;
          const fStat = fs.statSync(path.join(dPath, f));
          recordingsSizeBytes += fStat.size;
        }
      } catch {}
    }
  }

  const effectiveDays = daysSet.size || (totalSegments > 0 ? 1 : 0);
  const avgDailyBytes = effectiveDays > 0 ? recordingsSizeBytes / effectiveDays : 0;

  return {
    totalBytes,
    usedBytes,
    freeBytes,
    percentUsed: Number(percentUsed.toFixed(1)),
    recordingsSizeBytes,
    totalSegments,
    effectiveRetentionDays: effectiveDays,
    avgDailyBytes: Math.round(avgDailyBytes),
    retentionTargetDays: config.RETENTION_DAYS,
  };
}

export function runRetentionCycle(): { deletedCount: number; freedBytes: number } {
  addLog('info', 'Starting storage retention cycle...');
  const now = Date.now();
  const maxAgeMs = config.RETENTION_DAYS * 24 * 3600 * 1000;

  const allFiles: { fullPath: string; date: string; name: string; mtime: number; size: number }[] = [];

  if (!fs.existsSync(config.RECORDINGS_DIR)) {
    return { deletedCount: 0, freedBytes: 0 };
  }

  const dates = fs.readdirSync(config.RECORDINGS_DIR);
  for (const d of dates) {
    if (!DATE_REGEX.test(d)) continue;
    const dPath = path.join(config.RECORDINGS_DIR, d);
    try {
      const files = fs.readdirSync(dPath);
      for (const f of files) {
        if (!FILE_REGEX.test(f)) continue;
        const fPath = path.join(dPath, f);
        const st = fs.statSync(fPath);
        allFiles.push({
          fullPath: fPath,
          date: d,
          name: f,
          mtime: st.mtimeMs,
          size: st.size,
        });
      }
    } catch {}
  }

  // Sort oldest first
  allFiles.sort((a, b) => a.mtime - b.mtime);

  let deletedCount = 0;
  let freedBytes = 0;

  // 1. Delete files older than retention days
  for (const item of [...allFiles]) {
    if (now - item.mtime > maxAgeMs) {
      try {
        fs.unlinkSync(item.fullPath);
        deletedCount++;
        freedBytes += item.size;
        addLog('info', `Purged old recording (> ${config.RETENTION_DAYS}d): ${item.date}/${item.name}`);
        // remove thumb
        const thumb = path.join(config.THUMBS_DIR, `${path.parse(item.name).name}.jpg`);
        if (fs.existsSync(thumb)) try { fs.unlinkSync(thumb); } catch {}
        allFiles.splice(allFiles.indexOf(item), 1);
      } catch (err) {
        addLog('error', `Failed to purge ${item.fullPath}`, String(err));
      }
    }
  }

  // 2. Check disk usage threshold
  let stats = getStorageStats();
  if (stats.percentUsed > config.MAX_DISK_USAGE_PERCENT) {
    addLog('warn', `Disk usage (${stats.percentUsed}%) exceeds ${config.MAX_DISK_USAGE_PERCENT}%. Purging oldest files...`);
    for (const item of [...allFiles]) {
      try {
        fs.unlinkSync(item.fullPath);
        deletedCount++;
        freedBytes += item.size;
        addLog('info', `Purged for disk limit: ${item.date}/${item.name} (${(item.size / 1024 / 1024).toFixed(1)}MB)`);
        const thumb = path.join(config.THUMBS_DIR, `${path.parse(item.name).name}.jpg`);
        if (fs.existsSync(thumb)) try { fs.unlinkSync(thumb); } catch {}
        allFiles.splice(allFiles.indexOf(item), 1);

        stats = getStorageStats();
        if (stats.percentUsed <= config.MAX_DISK_USAGE_PERCENT - 2) {
          break;
        }
      } catch (err) {
        addLog('error', `Failed to purge ${item.fullPath}`, String(err));
      }
    }
  }

  // 3. Remove empty date directories
  for (const d of dates) {
    if (!DATE_REGEX.test(d)) continue;
    const dPath = path.join(config.RECORDINGS_DIR, d);
    try {
      if (fs.readdirSync(dPath).length === 0) {
        fs.rmdirSync(dPath);
        addLog('info', `Removed empty date directory: ${d}`);
      }
    } catch {}
  }

  addLog('info', `Retention cycle finished. Freed ${deletedCount} files (${(freedBytes / 1024 / 1024).toFixed(2)} MB).`);
  return { deletedCount, freedBytes };
}

export function initRetentionScheduler() {
  // Run on startup
  setTimeout(() => runRetentionCycle(), 5000);
  // Run every 1 hour
  setInterval(() => runRetentionCycle(), 3600 * 1000);
}
