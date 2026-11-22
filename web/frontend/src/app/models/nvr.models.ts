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

export interface LightState {
  on: boolean;
  mode: 'manual' | 'auto';
  updatedAt: string;
  source?: string;
  state?: 'day' | 'night' | 'unknown';
}

export interface DayNightState {
  state: 'day' | 'night' | 'unknown';
  source: 'inferred';
  saturation: number;
  brightness: number;
  updatedAt: string;
}

export interface MotionEvent {
  id: number;
  start_time: string;
  end_time: string | null;
  duration_s: number;
  score: number;
  snapshot_path: string | null;
  source: string;
  created_at: string;
}

export interface RecorderStatus {
  mode: 'continuous' | 'motion' | 'paused';
  active: boolean;
  isRecordingMotion: boolean;
  currentSegment?: string;
  prerollBufferCount: number;
}
