export interface HealthStatus {
  status: 'ok' | 'degraded' | 'error';
  timestamp: string;
  camera: {
    online: boolean;
    host: string;
    responseTimeMs?: number;
  };
  go2rtc: {
    online: boolean;
    url: string;
    streams?: Record<string, any>;
  };
  recorder: {
    active: boolean;
  };
}

export interface PresetInfo {
  number: number;
  name: string;
  updatedAt?: string;
}

export interface DaySummary {
  date: string;
  segmentCount: number;
  totalSizeBytes: number;
}

export interface SegmentInfo {
  fileName: string;
  date: string;
  startTime: string;
  fullTimestamp: string;
  sizeBytes: number;
  durationSeconds: number;
  isRecording: boolean;
  hasThumb: boolean;
}

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

export interface LogEntry {
  id: string;
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  details?: any;
}
