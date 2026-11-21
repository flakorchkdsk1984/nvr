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
  }
}
