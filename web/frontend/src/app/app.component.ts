import {
  Component,
  OnInit,
  OnDestroy,
  AfterViewInit,
  HostListener,
  inject,
  signal,
  ElementRef,
  ViewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import Hls from 'hls.js';
import { NvrService } from './services/nvr.service';
import { SegmentInfo, PresetInfo } from './models/nvr.models';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss'],
})
export class AppComponent implements OnInit, OnDestroy, AfterViewInit {
  public nvr = inject(NvrService);

  // Tab navigation
  activeTab = signal<'live' | 'recordings' | 'system'>('live');

  // Login form
  loginUser = '';
  loginPass = '';
  loginError = signal<string>('');

  // Recorder control
  recorderLoading = signal<boolean>(false);

  // Live stream state
  selectedStream = signal<'c2l_hd' | 'c2l_sd'>('c2l_hd');
  streamMode = signal<'mse' | 'hls' | 'snapshot'>('mse');
  liveStats = signal<{ status: string; latency: string; buffer: string }>({
    status: 'Iniciando...',
    latency: '0s',
    buffer: '0s',
  });
  snapshotLoopUrl = signal<string>('/api/snapshot');

  @ViewChild('liveVideo') liveVideoRef?: ElementRef<HTMLVideoElement>;
  private liveWs?: WebSocket;
  private mediaSource?: MediaSource;
  private sourceBuffer?: SourceBuffer;
  private bufferQueue: ArrayBuffer[] = [];
  private reconnectTimer: any = null;
  private hlsInstance?: Hls;
  private snapshotInterval: any = null;
  private isDestroyed = false;

  // System Config (Camera IP, Recordings dir, etc.)
  configCameraHost = '192.168.1.40';
  configCameraPort = 80;
  configRecordingsDir = '/home/chkdsk/c2l_nvr/recordings';
  configRetentionDays = 7;
  configSaving = signal<boolean>(false);
  configMsg = signal<string>('');
  configMsgIsError = signal<boolean>(false);

  // PTZ state
  ptzSpeed = 5;
  ptzContinuous = false;
  isHolding = false;
  holdInterval: any = null;

  // Digital Zoom & Pan state
  digitalZoom = signal<number>(1.0);
  zoomPanX = signal<number>(0);
  zoomPanY = signal<number>(0);
  isPanning = false;
  panStartX = 0;
  panStartY = 0;

  // Preset editor modal
  editingPreset = signal<PresetInfo | null>(null);
  presetNameInput = '';

  // Recordings & Player state
  activeSegment = signal<SegmentInfo | null>(null);
  playbackSpeed = 1.0;
  @ViewChild('videoPlayer') videoPlayerRef!: ElementRef<HTMLVideoElement>;

  // Clip Export Modal state
  exportingSegment = signal<SegmentInfo | null>(null);
  clipStartSeconds = 0;
  clipDurationSeconds = 60;
  exportingLoading = signal<boolean>(false);
  exportedDownloadUrl = signal<string | null>(null);

  // Polling intervals
  private healthInterval: any = null;

  ngOnInit() {
    this.nvr.checkAuth().subscribe((user) => {
      if (user) {
        this.nvr.refreshAll();
        this.loadConfig();
        this.startHealthPolling();
        setTimeout(() => this.initLivePlayer(), 150);
      }
    });
  }

  ngAfterViewInit() {
    if (this.nvr.currentUser() && this.activeTab() === 'live') {
      setTimeout(() => this.initLivePlayer(), 150);
    }
  }

  ngOnDestroy() {
    this.isDestroyed = true;
    this.stopHealthPolling();
    this.stopHolding();
    this.destroyLiveStream();
  }

  startHealthPolling() {
    this.stopHealthPolling();
    this.healthInterval = setInterval(() => {
      if (this.nvr.currentUser()) {
        this.nvr.fetchHealth().subscribe();
        this.nvr.fetchStorage().subscribe();
      }
    }, 10000);
  }

  stopHealthPolling() {
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
      this.healthInterval = null;
    }
  }

  // Auth
  onLogin() {
    this.loginError.set('');
    if (!this.loginUser || !this.loginPass) {
      this.loginError.set('Ingresa usuario y contraseña.');
      return;
    }
    this.nvr.login(this.loginUser, this.loginPass).subscribe({
      next: () => {
        this.loginPass = '';
        this.startHealthPolling();
        setTimeout(() => this.initLivePlayer(), 150);
      },
      error: (err) => {
        this.loginError.set(err.error?.error || 'Error al iniciar sesión');
      },
    });
  }

  onLogout() {
    this.destroyLiveStream();
    this.nvr.logout().subscribe(() => {
      this.stopHealthPolling();
    });
  }

  // Navigation & Tabs
  selectTab(tab: 'live' | 'recordings' | 'system') {
    if (this.activeTab() === 'live' && tab !== 'live') {
      this.destroyLiveStream();
    }
    this.activeTab.set(tab);
    if (tab === 'live') {
      setTimeout(() => this.initLivePlayer(), 150);
    }
  }

  // Recorder Control
  toggleRecorder() {
    const isActive = this.nvr.health()?.recorder?.active;
    this.recorderLoading.set(true);
    const req = isActive ? this.nvr.stopRecorder() : this.nvr.startRecorder();
    req.subscribe({
      next: () => {
        this.recorderLoading.set(false);
      },
      error: () => {
        this.recorderLoading.set(false);
      },
    });
  }

  // Stream Controls
  changeMode(mode: 'mse' | 'hls' | 'snapshot') {
    this.streamMode.set(mode);
    this.initLivePlayer();
  }

  changeStream(stream: 'c2l_hd' | 'c2l_sd') {
    this.selectedStream.set(stream);
    this.initLivePlayer();
  }

  initLivePlayer() {
    if (this.activeTab() !== 'live' || !this.nvr.currentUser()) return;
    const mode = this.streamMode();
    const stream = this.selectedStream();
    if (mode === 'mse') {
      this.startMsePlayer(stream);
    } else if (mode === 'hls') {
      this.startHlsPlayer(stream);
    } else if (mode === 'snapshot') {
      this.startSnapshotLoop();
    }
  }

  startMsePlayer(streamName: string) {
    this.destroyLiveStream();
    const video = this.liveVideoRef?.nativeElement;
    if (!video) return;

    video.muted = true;
    this.liveStats.set({ status: 'Conectando...', latency: '0s', buffer: '0s' });

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${window.location.host}/go2rtc/api/ws?src=${encodeURIComponent(streamName)}`;
    const ws = new WebSocket(wsUrl);
    this.liveWs = ws;
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      this.liveStats.set({ status: 'Sincronizando stream...', latency: '0s', buffer: '0s' });
      ws.send(JSON.stringify({ type: 'mse', value: 'video/mp4; codecs="avc1.640029"' }));
    };

    const ms = new MediaSource();
    this.mediaSource = ms;
    video.src = URL.createObjectURL(ms);

    ms.addEventListener(
      'sourceopen',
      () => {
        URL.revokeObjectURL(video.src);
      },
      { once: true }
    );

    ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'mse' && msg.value) {
            const codec = msg.value;
            if (!this.sourceBuffer && ms.readyState === 'open') {
              const sb = ms.addSourceBuffer(codec);
              sb.mode = 'segments';
              this.sourceBuffer = sb;

              const appendFromQueue = () => {
                if (this.sourceBuffer && !this.sourceBuffer.updating && this.bufferQueue.length > 0) {
                  const chunk = this.bufferQueue.shift()!;
                  try {
                    this.sourceBuffer.appendBuffer(chunk);
                  } catch (e) {
                    console.warn('MSE append error:', e);
                  }
                }
              };

              sb.addEventListener('updateend', () => {
                if (video && sb.buffered.length > 0) {
                  const end = sb.buffered.end(sb.buffered.length - 1);
                  const start = sb.buffered.start(0);
                  const current = video.currentTime;
                  const latency = Math.max(0, end - current);

                  this.liveStats.set({
                    status: 'En vivo (MSE Fluido)',
                    latency: `${latency.toFixed(2)}s`,
                    buffer: `${(end - start).toFixed(1)}s`,
                  });

                  // Ensure playback continues smoothly
                  if (video.paused) {
                    video.play().catch(() => {});
                  }

                  // Latency catch-up: smooth and steady!
                  if (current < start || latency > 3.0) {
                    // Far behind: seek close to the live edge
                    video.currentTime = Math.max(start, end - 0.2);
                    video.playbackRate = 1.0;
                  } else if (latency > 0.8) {
                    // Slightly behind: speed up gently by 6% without stutter
                    video.playbackRate = 1.06;
                  } else {
                    video.playbackRate = 1.0;
                  }

                  // Buffer management:
                  // Only evict when more than 25s accumulated.
                  // Always keep at least 15s behind current playhead!
                  if (end - start > 25 && !sb.updating) {
                    const safeEvictEnd = Math.min(end - 15, current - 5);
                    if (safeEvictEnd > start + 5) {
                      sb.remove(start, safeEvictEnd);
                      return;
                    }
                  }
                }
                appendFromQueue();
              });

              appendFromQueue();
            }
          }
        } catch (e) {
          console.error('Error handling go2rtc message:', e);
        }
      } else if (event.data instanceof ArrayBuffer) {
        if (this.sourceBuffer && !this.sourceBuffer.updating && this.bufferQueue.length === 0) {
          try {
            this.sourceBuffer.appendBuffer(event.data);
          } catch {
            this.bufferQueue.push(event.data);
          }
        } else {
          this.bufferQueue.push(event.data);
        }
      }
    };

    ws.onclose = () => {
      this.liveStats.set({ status: 'Reconectando stream...', latency: '-', buffer: '-' });
      if (!this.isDestroyed) {
        this.reconnectTimer = setTimeout(() => {
          if (this.activeTab() === 'live' && this.streamMode() === 'mse') {
            this.startMsePlayer(this.selectedStream());
          }
        }, 2000);
      }
    };
  }

  startHlsPlayer(streamName: string) {
    this.destroyLiveStream();
    const video = this.liveVideoRef?.nativeElement;
    if (!video) return;

    video.muted = true;
    this.liveStats.set({ status: 'Iniciando HLS...', latency: '~2s', buffer: '-' });
    const hlsUrl = `/go2rtc/api/stream.m3u8?src=${encodeURIComponent(streamName)}`;

    if (Hls.isSupported()) {
      const hls = new Hls({
        liveSyncDurationCount: 2,
        maxLiveSyncPlaybackRate: 1.1,
      });
      this.hlsInstance = hls;
      hls.loadSource(hlsUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => {});
        this.liveStats.set({ status: 'En vivo (HLS)', latency: '~2s', buffer: 'OK' });
      });
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) {
          this.liveStats.set({ status: 'Reintentando HLS...', latency: '-', buffer: '-' });
          hls.startLoad();
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = hlsUrl;
      video.play().catch(() => {});
      this.liveStats.set({ status: 'En vivo (HLS)', latency: '~2s', buffer: 'OK' });
    }
  }

  startSnapshotLoop() {
    this.destroyLiveStream();
    this.liveStats.set({ status: 'Snapshot (1s)', latency: '1.0s', buffer: '-' });
    this.snapshotLoopUrl.set(`/api/snapshot?t=${Date.now()}`);
    this.snapshotInterval = setInterval(() => {
      this.snapshotLoopUrl.set(`/api/snapshot?t=${Date.now()}`);
    }, 1000);
  }

  stopSnapshotLoop() {
    if (this.snapshotInterval) {
      clearInterval(this.snapshotInterval);
      this.snapshotInterval = null;
    }
  }

  destroyLiveStream() {
    this.stopSnapshotLoop();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.liveWs) {
      this.liveWs.onclose = null;
      this.liveWs.onerror = null;
      this.liveWs.onmessage = null;
      this.liveWs.close();
      this.liveWs = undefined;
    }
    if (this.hlsInstance) {
      this.hlsInstance.destroy();
      this.hlsInstance = undefined;
    }
    this.bufferQueue = [];
    if (this.sourceBuffer) {
      try {
        if (this.mediaSource && this.mediaSource.readyState === 'open') {
          this.mediaSource.removeSourceBuffer(this.sourceBuffer);
        }
      } catch {}
      this.sourceBuffer = undefined;
    }
    if (this.mediaSource) {
      try {
        if (this.mediaSource.readyState === 'open') {
          this.mediaSource.endOfStream();
        }
      } catch {}
      this.mediaSource = undefined;
    }
    if (this.liveVideoRef?.nativeElement) {
      this.liveVideoRef.nativeElement.src = '';
      this.liveVideoRef.nativeElement.load();
    }
  }

  // Snapshot
  downloadSnapshot() {
    const a = document.createElement('a');
    a.href = `/api/snapshot?t=${Date.now()}`;
    a.download = `snapshot_${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  toggleFullscreen(elem: HTMLElement) {
    if (!document.fullscreenElement) {
      elem.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }

  // PTZ Control
  startMove(action: string) {
    const step = this.ptzContinuous ? 0 : 1;
    this.nvr.movePtz(action, step, this.ptzSpeed).subscribe();

    if (this.ptzContinuous) {
      this.isHolding = true;
      clearInterval(this.holdInterval);
      this.holdInterval = setInterval(() => {
        if (this.isHolding) {
          this.nvr.movePtz(action, 0, this.ptzSpeed).subscribe();
        }
      }, 200);
    }
  }

  stopHolding() {
    if (this.isHolding || this.ptzContinuous) {
      this.isHolding = false;
      clearInterval(this.holdInterval);
      this.holdInterval = null;
      this.nvr.movePtz('stop', 0, this.ptzSpeed).subscribe();
    }
  }

  sendPtzStop() {
    this.isHolding = false;
    clearInterval(this.holdInterval);
    this.nvr.movePtz('stop', 0, this.ptzSpeed).subscribe();
  }

  // Zoom Controls (Digital smooth scaling + Hardware CGI command)
  zoomIn(step: number = 0.5) {
    const current = this.digitalZoom();
    const next = Math.min(5.0, Math.round((current + step) * 10) / 10);
    this.digitalZoom.set(next);
    this.clampPan();
    this.nvr.movePtz('zoomin', 1, this.ptzSpeed).subscribe({ error: () => {} });
  }

  zoomOut(step: number = 0.5) {
    const current = this.digitalZoom();
    const next = Math.max(1.0, Math.round((current - step) * 10) / 10);
    this.digitalZoom.set(next);
    if (next === 1.0) {
      this.zoomPanX.set(0);
      this.zoomPanY.set(0);
    } else {
      this.clampPan();
    }
    this.nvr.movePtz('zoomout', 1, this.ptzSpeed).subscribe({ error: () => {} });
  }

  resetZoom() {
    this.digitalZoom.set(1.0);
    this.zoomPanX.set(0);
    this.zoomPanY.set(0);
    this.nvr.movePtz('stop', 0, this.ptzSpeed).subscribe({ error: () => {} });
  }

  onPlayerWheel(event: WheelEvent) {
    event.preventDefault();
    if (event.deltaY < 0) {
      this.zoomIn(0.25);
    } else if (event.deltaY > 0) {
      this.zoomOut(0.25);
    }
  }

  onPlayerDblClick(event: MouseEvent) {
    event.preventDefault();
    if (this.digitalZoom() > 1.0) {
      this.resetZoom();
    } else {
      this.zoomIn(1.0);
    }
  }

  startPan(event: MouseEvent) {
    if (this.digitalZoom() <= 1.0 || event.button !== 0) return;
    event.preventDefault();
    this.isPanning = true;
    this.panStartX = event.clientX - this.zoomPanX();
    this.panStartY = event.clientY - this.zoomPanY();
  }

  doPan(event: MouseEvent) {
    if (!this.isPanning || this.digitalZoom() <= 1.0) return;
    event.preventDefault();
    this.zoomPanX.set(event.clientX - this.panStartX);
    this.zoomPanY.set(event.clientY - this.panStartY);
    this.clampPan();
  }

  stopPan() {
    this.isPanning = false;
  }

  startTouchPan(event: TouchEvent) {
    if (this.digitalZoom() <= 1.0 || event.touches.length !== 1) return;
    this.isPanning = true;
    this.panStartX = event.touches[0].clientX - this.zoomPanX();
    this.panStartY = event.touches[0].clientY - this.zoomPanY();
  }

  doTouchPan(event: TouchEvent) {
    if (!this.isPanning || this.digitalZoom() <= 1.0 || event.touches.length !== 1) return;
    this.zoomPanX.set(event.touches[0].clientX - this.panStartX);
    this.zoomPanY.set(event.touches[0].clientY - this.panStartY);
    this.clampPan();
  }

  private clampPan() {
    const zoom = this.digitalZoom();
    if (zoom <= 1.0) {
      this.zoomPanX.set(0);
      this.zoomPanY.set(0);
      return;
    }
    const maxPanX = (zoom - 1) * 350;
    const maxPanY = (zoom - 1) * 200;
    const curX = this.zoomPanX();
    const curY = this.zoomPanY();
    this.zoomPanX.set(Math.max(-maxPanX, Math.min(maxPanX, curX)));
    this.zoomPanY.set(Math.max(-maxPanY, Math.min(maxPanY, curY)));
  }

  // Presets
  gotoPreset(num: number) {
    this.nvr.triggerPreset('goto', num).subscribe({
      next: () => {},
      error: (err) => {
        console.warn('Error moviendo al preset:', err);
      },
    });
  }

  openSavePresetModal(preset: PresetInfo) {
    this.editingPreset.set(preset);
    this.presetNameInput = preset.name;
  }

  savePreset() {
    const preset = this.editingPreset();
    if (!preset) return;
    this.nvr.triggerPreset('set', preset.number, this.presetNameInput || preset.name).subscribe({
      next: () => {
        this.editingPreset.set(null);
      },
      error: (err) => {
        console.warn('Error guardando preset:', err);
        this.editingPreset.set(null);
      },
    });
  }

  // Keyboard navigation
  @HostListener('window:keydown', ['$event'])
  handleKeyboard(event: KeyboardEvent) {
    // Only handle when not typing in inputs
    if (['INPUT', 'TEXTAREA'].includes((event.target as HTMLElement)?.tagName)) {
      return;
    }

    if (this.activeTab() === 'live') {
      switch (event.key) {
        case 'ArrowUp':
          event.preventDefault();
          this.startMove('up');
          break;
        case 'ArrowDown':
          event.preventDefault();
          this.startMove('down');
          break;
        case 'ArrowLeft':
          event.preventDefault();
          this.startMove('left');
          break;
        case 'ArrowRight':
          event.preventDefault();
          this.startMove('right');
          break;
        case ' ':
          event.preventDefault();
          this.sendPtzStop();
          break;
      }
    } else if (this.activeTab() === 'recordings' && this.videoPlayerRef) {
      const vid = this.videoPlayerRef.nativeElement;
      switch (event.key) {
        case ' ':
          event.preventDefault();
          vid.paused ? vid.play() : vid.pause();
          break;
        case 'ArrowLeft':
          event.preventDefault();
          vid.currentTime = Math.max(0, vid.currentTime - 10);
          break;
        case 'ArrowRight':
          event.preventDefault();
          vid.currentTime = Math.min(vid.duration || vid.currentTime, vid.currentTime + 10);
          break;
        case 'f':
        case 'F':
          event.preventDefault();
          this.toggleFullscreen(vid);
          break;
      }
    }
  }

  // Recordings Methods
  selectDate(date: string) {
    this.activeSegment.set(null);
    this.nvr.loadDateSegments(date).subscribe((segs) => {
      if (segs.length > 0) {
        this.playSegment(segs[0]);
      }
    });
  }

  playSegment(seg: SegmentInfo) {
    this.activeSegment.set(seg);
    if (this.videoPlayerRef) {
      const video = this.videoPlayerRef.nativeElement;
      video.src = `/api/recordings/${seg.date}/${seg.fileName}`;
      video.load();
      video.playbackRate = this.playbackSpeed;
      video.play().catch(() => {});
    }
  }

  setSpeed(speed: number) {
    this.playbackSpeed = speed;
    if (this.videoPlayerRef) {
      this.videoPlayerRef.nativeElement.playbackRate = speed;
    }
  }

  playNextSegment() {
    const cur = this.activeSegment();
    if (!cur) return;
    const segs = this.nvr.segments();
    const idx = segs.findIndex((s) => s.fileName === cur.fileName);
    if (idx !== -1 && idx + 1 < segs.length) {
      this.playSegment(segs[idx + 1]);
    }
  }

  deleteRecording(seg: SegmentInfo) {
    if (confirm(`¿Deseas eliminar permanentemente el archivo ${seg.fileName}?`)) {
      this.nvr.deleteSegment(seg.date, seg.fileName).subscribe(() => {
        if (this.activeSegment()?.fileName === seg.fileName) {
          this.activeSegment.set(null);
        }
      });
    }
  }

  openExportClipModal(seg: SegmentInfo) {
    this.exportingSegment.set(seg);
    this.clipStartSeconds = 0;
    this.clipDurationSeconds = Math.min(60, seg.durationSeconds || 60);
    this.exportedDownloadUrl.set(null);
  }

  submitExportClip() {
    const seg = this.exportingSegment();
    if (!seg) return;
    this.exportingLoading.set(true);
    this.exportedDownloadUrl.set(null);

    this.nvr
      .exportClip(seg.date, seg.fileName, this.clipStartSeconds, this.clipDurationSeconds)
      .subscribe({
        next: (res) => {
          this.exportingLoading.set(false);
          this.exportedDownloadUrl.set(res.downloadUrl);
        },
        error: (err) => {
          this.exportingLoading.set(false);
          alert(`Error al exportar clip: ${err.error?.error || err.message}`);
        },
      });
  }

  // System & Storage
  loadConfig() {
    this.nvr.fetchConfig().subscribe({
      next: (cfg) => {
        if (cfg) {
          this.configCameraHost = cfg.cameraHost;
          this.configCameraPort = cfg.cameraPort;
          this.configRecordingsDir = cfg.recordingsDir;
          this.configRetentionDays = cfg.retentionDays;
        }
      },
    });
  }

  saveConfig() {
    this.configSaving.set(true);
    this.configMsg.set('');
    this.nvr
      .saveConfig({
        cameraHost: this.configCameraHost,
        cameraPort: this.configCameraPort,
        recordingsDir: this.configRecordingsDir,
        retentionDays: this.configRetentionDays,
      })
      .subscribe({
        next: (res) => {
          this.configSaving.set(false);
          this.configMsgIsError.set(!res.success);
          this.configMsg.set(res.message);
          if (res.success) {
            setTimeout(() => {
              if (this.activeTab() === 'live') {
                this.initLivePlayer();
              }
            }, 2000);
          }
        },
        error: (err) => {
          this.configSaving.set(false);
          this.configMsgIsError.set(true);
          this.configMsg.set(err.error?.error || err.message);
        },
      });
  }

  triggerManualRetention() {
    if (confirm('¿Ejecutar ciclo de limpieza y retención manual ahora?')) {
      this.nvr.runRetention().subscribe();
    }
  }

  formatBytes(bytes: number): string {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  formatDuration(seconds: number): string {
    if (!seconds) return '00:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
}
