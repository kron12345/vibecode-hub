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

export interface StreamStartEvent {
  chatSessionId: string;
  role: string;
}

export interface StreamTokenEvent {
  chatSessionId: string;
  token: string;
}

export interface StreamEndEvent {
  chatSessionId: string;
}

export interface ChatSuggestionsEvent {
  chatSessionId: string;
  suggestions: string[];
}

export interface InterviewProgressEvent {
  chatSessionId: string;
  projectId: string;
  progress: {
    framework?: string;
    language?: string;
    backend?: string;
    database?: string;
    features?: { title: string; priority: string; description?: string }[];
    setupReady?: boolean;
  };
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
  /** Streaming events — token-by-token LLM output */
  readonly streamStart$ = new Subject<StreamStartEvent>();
  readonly streamToken$ = new Subject<StreamTokenEvent>();
  readonly streamEnd$ = new Subject<StreamEndEvent>();
  /** Interview-specific events */
  readonly chatSuggestions$ = new Subject<ChatSuggestionsEvent>();
  readonly interviewProgress$ = new Subject<InterviewProgressEvent>();

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

    this.socket.on('chatStreamStart', (event: StreamStartEvent) => {
      this.streamStart$.next(event);
    });

    this.socket.on('chatStreamToken', (event: StreamTokenEvent) => {
      this.streamToken$.next(event);
    });

    this.socket.on('chatStreamEnd', (event: StreamEndEvent) => {
      this.streamEnd$.next(event);
    });

    this.socket.on('chatSuggestions', (event: ChatSuggestionsEvent) => {
      this.chatSuggestions$.next(event);
    });

    this.socket.on('interviewProgress', (event: InterviewProgressEvent) => {
      this.interviewProgress$.next(event);
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
