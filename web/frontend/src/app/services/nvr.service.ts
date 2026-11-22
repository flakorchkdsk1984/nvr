import { Injectable, signal, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, tap, catchError, of } from 'rxjs';
import {
  HealthStatus,
  PresetInfo,
  DaySummary,
  SegmentInfo,
  StorageStats,
  LogEntry,
  LightState,
  DayNightState,
  MotionEvent,
  RecorderStatus,
} from '../models/nvr.models';

@Injectable({
  providedIn: 'root',
})
export class NvrService {
  private http = inject(HttpClient);

  // Reactive state signals
  currentUser = signal<string | null>(null);
  health = signal<HealthStatus | null>(null);
  storage = signal<StorageStats | null>(null);
  presets = signal<PresetInfo[]>([]);
  days = signal<DaySummary[]>([]);
  currentDate = signal<string>('');
  segments = signal<SegmentInfo[]>([]);
  logs = signal<LogEntry[]>([]);
  light = signal<LightState>({ on: false, mode: 'manual', updatedAt: '' });
  dayNight = signal<DayNightState>({ state: 'unknown', source: 'inferred', saturation: 0, brightness: 0, updatedAt: '' });
  recorderStatus = signal<RecorderStatus>({ mode: 'continuous', active: false, isRecordingMotion: false, prerollBufferCount: 0 });
  events = signal<MotionEvent[]>([]);
  motionActive = signal<boolean>(false);
  motionScore = signal<number>(0);

  // Auth
  checkAuth(): Observable<{ user: string } | null> {
    return this.http.get<{ user: string }>('/api/auth/me').pipe(
      tap((res) => this.currentUser.set(res.user)),
      catchError(() => {
        this.currentUser.set(null);
        return of(null);
      })
    );
  }

  login(username: string, password: string): Observable<{ success: boolean; user: string }> {
    return this.http.post<{ success: boolean; user: string }>('/api/auth/login', { username, password }).pipe(
      tap((res) => {
        if (res.success) {
          this.currentUser.set(res.user);
          this.refreshAll();
        }
      })
    );
  }

  logout(): Observable<{ success: boolean }> {
    return this.http.post<{ success: boolean }>('/api/auth/logout', {}).pipe(
      tap(() => {
        this.currentUser.set(null);
      })
    );
  }

  // Health
  fetchHealth(): Observable<HealthStatus> {
    return this.http.get<HealthStatus>('/api/health').pipe(
      tap((h) => this.health.set(h))
    );
  }

  // Recorder control
  startRecorder(): Observable<{ success: boolean; message: string; active: boolean }> {
    return this.http.post<{ success: boolean; message: string; active: boolean }>('/api/recorder/start', {}).pipe(
      tap(() => this.fetchHealth().subscribe())
    );
  }

  stopRecorder(): Observable<{ success: boolean; message: string; active: boolean }> {
    return this.http.post<{ success: boolean; message: string; active: boolean }>('/api/recorder/stop', {}).pipe(
      tap(() => this.fetchHealth().subscribe())
    );
  }

  // PTZ
  movePtz(action: string, step: number = 1, speed: number = 5): Observable<any> {
    return this.http.post('/api/ptz/move', { action, step, speed });
  }

  triggerPreset(action: 'goto' | 'set', number: number, name?: string): Observable<any> {
    return this.http.post('/api/ptz/preset', { action, number, name }).pipe(
      tap(() => this.fetchPresets().subscribe())
    );
  }

  fetchPresets(): Observable<PresetInfo[]> {
    return this.http.get<PresetInfo[]>('/api/ptz/presets').pipe(
      tap((list) => this.presets.set(list))
    );
  }

  // Recordings
  fetchDays(): Observable<DaySummary[]> {
    return this.http.get<DaySummary[]>('/api/recordings').pipe(
      tap((d) => {
        this.days.set(d);
        if (d.length > 0 && !this.currentDate()) {
          this.loadDateSegments(d[0].date);
        }
      })
    );
  }

  loadDateSegments(date: string): Observable<SegmentInfo[]> {
    this.currentDate.set(date);
    return this.http.get<SegmentInfo[]>(`/api/recordings?date=${date}`).pipe(
      tap((list) => this.segments.set(list))
    );
  }

  deleteSegment(date: string, file: string): Observable<any> {
    return this.http.delete(`/api/recordings/${date}/${file}`).pipe(
      tap(() => {
        this.loadDateSegments(date).subscribe();
        this.fetchStorage().subscribe();
      })
    );
  }

  exportClip(date: string, file: string, startSeconds: number, durationSeconds: number): Observable<{ downloadUrl: string }> {
    return this.http.post<{ downloadUrl: string }>('/api/recordings/clip', {
      date,
      file,
      startSeconds,
      durationSeconds,
    });
  }

  // Storage
  fetchStorage(): Observable<StorageStats> {
    return this.http.get<StorageStats>('/api/storage').pipe(
      tap((s) => this.storage.set(s))
    );
  }

  runRetention(): Observable<any> {
    return this.http.post('/api/retention/run', {}).pipe(
      tap(() => {
        this.fetchStorage().subscribe();
        this.fetchDays().subscribe();
        this.fetchLogs().subscribe();
      })
    );
  }

  // Config (Camera IP, Recordings Dir, Retention)
  fetchConfig(): Observable<{ cameraHost: string; cameraPort: number; cameraUser: string; recordingsDir: string; retentionDays: number }> {
    return this.http.get<any>('/api/config');
  }

  saveConfig(data: { cameraHost: string; cameraPort: number; recordingsDir?: string; retentionDays?: number }): Observable<any> {
    return this.http.post('/api/config', data).pipe(
      tap(() => {
        this.fetchHealth().subscribe();
        this.fetchStorage().subscribe();
        this.fetchLogs().subscribe();
      })
    );
  }

  // Light & Day/Night Control
  fetchLight(): Observable<LightState> {
    return this.http.get<LightState>('/api/light').pipe(
      tap((s) => this.light.set(s))
    );
  }

  fetchDayNight(): Observable<DayNightState> {
    return this.http.get<DayNightState>('/api/daynight').pipe(
      tap((s) => this.dayNight.set(s))
    );
  }

  setLight(on: boolean): Observable<{ success: boolean; state: LightState }> {
    return this.http.post<{ success: boolean; state: LightState }>('/api/light', { on }).pipe(
      tap((res) => {
        if (res.state) this.light.set(res.state);
      })
    );
  }

  // Recorder Modes
  fetchRecorderStatus(): Observable<RecorderStatus> {
    return this.http.get<RecorderStatus>('/api/recorder/mode').pipe(
      tap((s) => this.recorderStatus.set(s))
    );
  }

  setRecorderMode(mode: 'continuous' | 'motion' | 'paused'): Observable<{ success: boolean; status: RecorderStatus }> {
    return this.http.post<{ success: boolean; status: RecorderStatus }>('/api/recorder/mode', { mode }).pipe(
      tap((res) => {
        if (res.status) {
          this.recorderStatus.set(res.status);
          this.fetchHealth().subscribe();
        }
      })
    );
  }

  // Motion Events
  fetchEvents(date?: string): Observable<MotionEvent[]> {
    const url = date ? `/api/events?date=${date}` : '/api/events';
    return this.http.get<MotionEvent[]>(url).pipe(
      tap((list) => this.events.set(list))
    );
  }

  initMotionLiveStream(): () => void {
    const eventSource = new EventSource('/api/events/live');

    eventSource.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'init') {
          if (msg.status) {
            this.motionActive.set(msg.status.active);
            this.motionScore.set(msg.status.score || 0);
          }
          if (msg.daynight) {
            this.dayNight.set(msg.daynight);
          }
        } else if (msg.type === 'daynight_change' && msg.data) {
          this.dayNight.set(msg.data);
        } else if (msg.type === 'motion_start' && msg.event) {
          this.motionActive.set(true);
          this.motionScore.set(msg.event.score || 0);
          this.events.update((list) => [msg.event, ...list.filter(e => e.id !== msg.event.id)]);
        } else if (msg.type === 'motion_active') {
          this.motionActive.set(true);
          if (msg.data?.score !== undefined) {
            this.motionScore.set(msg.data.score);
          }
        } else if (msg.type === 'motion_end' && msg.event) {
          this.motionActive.set(false);
          this.motionScore.set(0);
          this.events.update((list) =>
            list.map((e) => (e.id === msg.event.id ? msg.event : e))
          );
        }
      } catch {}
    };

    return () => {
      eventSource.close();
    };
  }

  // Logs
  fetchLogs(limit = 50): Observable<LogEntry[]> {
    return this.http.get<LogEntry[]>(`/api/logs?limit=${limit}`).pipe(
      tap((l) => this.logs.set(l))
    );
  }

  refreshAll() {
    this.fetchHealth().subscribe();
    this.fetchPresets().subscribe();
    this.fetchDays().subscribe();
    this.fetchStorage().subscribe();
    this.fetchLogs().subscribe();
    this.fetchLight().subscribe();
    this.fetchDayNight().subscribe();
    this.fetchRecorderStatus().subscribe();
    this.fetchEvents().subscribe();
  }
}
