import { Injectable, OnDestroy } from '@angular/core';
import { Subject } from 'rxjs';
import { io, Socket } from 'socket.io-client';
import { environment } from '../../environments/environment';
import { ChatMessage } from './api.service';

export interface AgentStatusEvent {
  agentInstanceId: string;
  role: string;
  status: string;
  projectId: string;
}

export interface ProjectUpdatedEvent {
  projectId: string;
  status: string;
}

@Injectable({ providedIn: 'root' })
export class ChatSocketService implements OnDestroy {
  private socket: Socket | null = null;
  private currentSessionId: string | null = null;

  /** Emits whenever a new message arrives via WebSocket */
  readonly newMessage$ = new Subject<ChatMessage>();
  /** Emits when an agent status changes */
  readonly agentStatus$ = new Subject<AgentStatusEvent>();
  /** Emits when a project is updated (e.g., interview complete) */
  readonly projectUpdated$ = new Subject<ProjectUpdatedEvent>();

  private connect() {
    if (this.socket) return;

    const wsUrl = environment.apiUrl.replace('/api', '');
    this.socket = io(`${wsUrl}/chat`, {
      transports: ['websocket'],
      withCredentials: true,
    });

    this.socket.on('newMessage', (message: ChatMessage) => {
      this.newMessage$.next(message);
    });

    this.socket.on('agentStatus', (event: AgentStatusEvent) => {
      this.agentStatus$.next(event);
    });

    this.socket.on('projectUpdated', (event: ProjectUpdatedEvent) => {
      this.projectUpdated$.next(event);
    });
  }

  joinSession(chatSessionId: string) {
    this.connect();
    if (this.currentSessionId) {
      this.leaveSession();
    }
    this.currentSessionId = chatSessionId;
    this.socket!.emit('joinSession', { chatSessionId });
  }

  leaveSession() {
    if (this.socket && this.currentSessionId) {
      this.socket.emit('leaveSession', {
        chatSessionId: this.currentSessionId,
      });
      this.currentSessionId = null;
    }
  }

  sendMessage(content: string) {
    if (this.socket && this.currentSessionId) {
      this.socket.emit('sendMessage', {
        chatSessionId: this.currentSessionId,
        content,
      });
    }
  }

  ngOnDestroy() {
    this.leaveSession();
    this.socket?.disconnect();
    this.socket = null;
  }
}
