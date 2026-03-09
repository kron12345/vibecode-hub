import { Injectable, OnDestroy, inject, signal } from '@angular/core';
import { io, Socket } from 'socket.io-client';
import { environment } from '../../environments/environment';
import { HardwareSnapshot, ActivityItem, ApiService } from './api.service';

@Injectable({ providedIn: 'root' })
export class MonitorSocketService implements OnDestroy {
  private socket: Socket | null = null;
  private api = inject(ApiService);
  private restFallbackInterval: ReturnType<typeof setInterval> | null = null;

  /** Latest hardware snapshot (reactive) */
  readonly hardware = signal<HardwareSnapshot | null>(null);

  /** History ring buffer for sparklines */
  readonly history = signal<HardwareSnapshot[]>([]);

  /** Live log entries */
  readonly logEntries = signal<ActivityItem[]>([]);

  /** Connection status */
  readonly connected = signal(false);

  private readonly MAX_LOG_ENTRIES = 200;

  connect() {
    if (this.socket?.connected) return;

    // Clean up old socket if exists but not connected
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }

    const url = environment.apiUrl.replace('/api', '');
    this.socket = io(`${url}/monitor`, {
      transports: ['websocket'],
      withCredentials: true,
      reconnection: true,
      reconnectionDelay: 3000,
      reconnectionAttempts: Infinity,
    });

    this.socket.on('connect', () => {
      this.connected.set(true);
      this.stopRestFallback();
    });

    this.socket.on('disconnect', () => {
      this.connected.set(false);
    });

    this.socket.on('connect_error', () => {
      this.connected.set(false);
      // Fallback: poll REST endpoint
      this.startRestFallback();
    });

    this.socket.on('hardwareStats', (snapshot: HardwareSnapshot) => {
      this.hardware.set(snapshot);
      this.history.update((h) => {
        const next = [...h, snapshot];
        return next.length > 60 ? next.slice(-60) : next;
      });
    });

    this.socket.on('hardwareHistory', (snapshots: HardwareSnapshot[]) => {
      this.history.set(snapshots);
    });

    this.socket.on('agentLogEntry', (entry: any) => {
      const item: ActivityItem = {
        type: 'log',
        id: entry.id,
        level: entry.level,
        message: entry.message,
        agentRole: entry.agentRole,
        projectId: entry.projectId,
        createdAt: entry.createdAt,
      };
      this.logEntries.update((entries) => {
        const next = [item, ...entries];
        return next.length > this.MAX_LOG_ENTRIES
          ? next.slice(0, this.MAX_LOG_ENTRIES)
          : next;
      });
    });

    this.socket.on('llmCall', (data: any) => {
      const item: ActivityItem = {
        type: 'log',
        id: `llm-${Date.now()}`,
        level: 'INFO',
        message: `LLM ${data.provider}/${data.model} — ${data.duration ?? '?'}ms`,
        agentRole: data.agentRole,
        projectId: data.projectId,
        createdAt: new Date().toISOString(),
      };
      this.logEntries.update((entries) => {
        const next = [item, ...entries];
        return next.length > this.MAX_LOG_ENTRIES
          ? next.slice(0, this.MAX_LOG_ENTRIES)
          : next;
      });
    });

    // Also try REST immediately for first paint
    this.pollRestOnce();
  }

  joinLogRoom(projectId?: string) {
    this.socket?.emit('joinLogRoom', { projectId });
  }

  leaveLogRoom(projectId?: string) {
    this.socket?.emit('leaveLogRoom', { projectId });
  }

  disconnect() {
    this.stopRestFallback();
    this.socket?.removeAllListeners();
    this.socket?.disconnect();
    this.socket = null;
    this.connected.set(false);
  }

  ngOnDestroy() {
    this.disconnect();
  }

  /** Poll REST API once — used for immediate first paint */
  private pollRestOnce() {
    this.api.getHardwareStats().subscribe({
      next: (snap) => {
        if (!this.hardware()) {
          this.hardware.set(snap);
        }
      },
      error: () => {
        // REST also not available — backend probably not running latest version
      },
    });
  }

  /** Start polling REST as fallback when WebSocket fails */
  private startRestFallback() {
    if (this.restFallbackInterval) return;
    this.restFallbackInterval = setInterval(() => {
      this.api.getHardwareStats().subscribe({
        next: (snap) => this.hardware.set(snap),
        error: () => {},
      });
    }, 5000);
  }

  private stopRestFallback() {
    if (this.restFallbackInterval) {
      clearInterval(this.restFallbackInterval);
      this.restFallbackInterval = null;
    }
  }
}
