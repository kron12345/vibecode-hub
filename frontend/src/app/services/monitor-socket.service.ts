import { Injectable, OnDestroy, signal } from '@angular/core';
import { io, Socket } from 'socket.io-client';
import { environment } from '../../environments/environment';
import { HardwareSnapshot, ActivityItem } from './api.service';

@Injectable({ providedIn: 'root' })
export class MonitorSocketService implements OnDestroy {
  private socket: Socket | null = null;

  /** Latest hardware snapshot (reactive) */
  readonly hardware = signal<HardwareSnapshot | null>(null);

  /** History ring buffer for sparklines */
  readonly history = signal<HardwareSnapshot[]>([]);

  /** Live log entries */
  readonly logEntries = signal<ActivityItem[]>([]);

  private readonly MAX_LOG_ENTRIES = 200;

  connect() {
    if (this.socket?.connected) return;

    const url = environment.apiUrl.replace('/api', '');
    this.socket = io(`${url}/monitor`, {
      transports: ['websocket'],
      withCredentials: true,
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
  }

  joinLogRoom(projectId?: string) {
    this.socket?.emit('joinLogRoom', { projectId });
  }

  leaveLogRoom(projectId?: string) {
    this.socket?.emit('leaveLogRoom', { projectId });
  }

  disconnect() {
    this.socket?.disconnect();
    this.socket = null;
  }

  ngOnDestroy() {
    this.disconnect();
  }
}
