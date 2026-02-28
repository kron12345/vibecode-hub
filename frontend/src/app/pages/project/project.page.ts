import {
  Component,
  inject,
  OnInit,
  OnDestroy,
  signal,
  viewChild,
  ElementRef,
  effect,
} from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import {
  ApiService,
  Project,
  Issue,
  ChatSession,
  ChatMessage,
} from '../../services/api.service';
import { ChatSocketService } from '../../services/chat-socket.service';

@Component({
  selector: 'app-project',
  imports: [FormsModule, RouterLink],
  template: `
    @if (project(); as p) {
      <div class="project-header">
        <a routerLink="/" class="back-link">← Dashboard</a>
        <h1>{{ p.name }}</h1>
        <p class="description">{{ p.description }}</p>
        @if (p.gitlabUrl) {
          <a [href]="p.gitlabUrl" target="_blank" class="gitlab-link">GitLab →</a>
        }
      </div>

      <div class="project-layout">
        <!-- Left: Agents -->
        <section class="sidebar agents-panel">
          <h3>Agenten</h3>
          @if (p.agents && p.agents.length > 0) {
            @for (agent of p.agents; track agent.id) {
              <div class="agent-card">
                <span class="agent-role">{{ agent.role }}</span>
                <span class="agent-status" [attr.data-status]="agent.status">
                  {{ agent.status }}
                </span>
              </div>
            }
          } @else {
            <p class="placeholder">Noch keine Agenten konfiguriert</p>
          }
        </section>

        <!-- Center: Chat -->
        <section class="main-area chat-panel">
          <div class="chat-header">
            <h3>Chat</h3>
            @if (!activeSession()) {
              <button class="btn-new-chat" (click)="createSession()">+ Neuer Chat</button>
            }
          </div>

          @if (activeSession(); as session) {
            <div class="chat-messages" #messageContainer>
              @for (msg of messages(); track msg.id) {
                <div class="message" [attr.data-role]="msg.role">
                  <span class="msg-role">{{ msg.role }}</span>
                  <div class="msg-content">{{ msg.content }}</div>
                  <span class="msg-time">{{ formatTime(msg.createdAt) }}</span>
                </div>
              }
              @if (messages().length === 0) {
                <p class="placeholder chat-empty">
                  Chat ist leer — schreib deine erste Anforderung!
                </p>
              }
            </div>
            <div class="chat-input">
              <input
                type="text"
                [(ngModel)]="messageInput"
                (keydown.enter)="sendMessage()"
                placeholder="Nachricht eingeben..."
                class="input-message"
              />
              <button class="btn-send" (click)="sendMessage()">Senden</button>
            </div>
          } @else {
            <!-- Session list -->
            <div class="session-list">
              @for (s of sessions(); track s.id) {
                <div class="session-card" (click)="openSession(s)">
                  <span class="session-title">{{ s.title }}</span>
                  <span class="session-date">{{ formatTime(s.updatedAt) }}</span>
                </div>
              }
              @if (sessions().length === 0) {
                <p class="placeholder chat-empty">
                  Noch keine Chats — erstelle einen neuen Chat um loszulegen.
                </p>
              }
            </div>
          }
        </section>

        <!-- Right: Issues -->
        <section class="sidebar issues-panel">
          <h3>Issues</h3>
          @for (issue of issues(); track issue.id) {
            <div class="issue-card" [attr.data-status]="issue.status" [attr.data-priority]="issue.priority">
              <div class="issue-header">
                <span class="issue-priority">{{ issue.priority }}</span>
                <span class="issue-status">{{ issue.status }}</span>
              </div>
              <span class="issue-title">{{ issue.title }}</span>
              @if (issue.subIssues && issue.subIssues.length > 0) {
                <span class="issue-subs">{{ issue.subIssues.length }} Sub-Issues</span>
              }
            </div>
          }
          @if (issues().length === 0) {
            <p class="placeholder">Noch keine Issues vorhanden</p>
          }
        </section>
      </div>
    } @else {
      <p class="loading">Projekt wird geladen...</p>
    }
  `,
  styles: `
    .project-header { margin-bottom: 1.5rem; }
    .project-header h1 { color: #eee; margin: 0.25rem 0; }
    .back-link {
      color: #e94560; text-decoration: none; font-size: 0.875rem;
      &:hover { text-decoration: underline; }
    }
    .description { color: #888; margin: 0.25rem 0; }
    .gitlab-link {
      color: #e94560; text-decoration: none; font-size: 0.875rem;
      &:hover { text-decoration: underline; }
    }

    .project-layout {
      display: grid;
      grid-template-columns: 240px 1fr 280px;
      gap: 1rem;
      min-height: 70vh;
    }

    .sidebar {
      background: #16213e; border-radius: 12px; padding: 1rem;
      overflow-y: auto; max-height: 75vh;
    }
    .sidebar h3 { color: #e94560; margin-top: 0; font-size: 1rem; }

    .main-area {
      background: #16213e; border-radius: 12px; padding: 1rem;
      display: flex; flex-direction: column;
    }
    .main-area h3 { color: #e94560; margin-top: 0; }

    .placeholder { color: #555; font-size: 0.875rem; }
    .loading { color: #888; text-align: center; padding: 2rem; }

    /* ─── Agents ─────────────────────────────── */
    .agent-card {
      display: flex; justify-content: space-between; align-items: center;
      background: #1a1a2e; border-radius: 8px; padding: 0.5rem 0.75rem; margin-bottom: 0.5rem;
    }
    .agent-role { color: #ccc; font-size: 0.8rem; text-transform: lowercase; }
    .agent-status {
      font-size: 0.7rem; padding: 2px 8px; border-radius: 12px; font-weight: bold;
    }
    .agent-status[data-status="IDLE"] { background: #333; color: #888; }
    .agent-status[data-status="WORKING"] { background: #1b4332; color: #52b788; }
    .agent-status[data-status="ERROR"] { background: #3d0000; color: #e94560; }

    /* ─── Chat ───────────────────────────────── */
    .chat-header {
      display: flex; justify-content: space-between; align-items: center;
      margin-bottom: 0.5rem;
    }
    .chat-header h3 { margin: 0; }
    .btn-new-chat {
      background: #e94560; color: white; border: none; border-radius: 8px;
      padding: 0.4rem 1rem; cursor: pointer; font-size: 0.85rem;
      &:hover { background: #c73652; }
    }

    .chat-messages {
      flex: 1; overflow-y: auto; padding: 0.5rem 0;
      display: flex; flex-direction: column; gap: 0.5rem;
    }
    .chat-empty { text-align: center; margin-top: 4rem; }

    .message {
      padding: 0.5rem 0.75rem; border-radius: 10px; max-width: 85%;
    }
    .message[data-role="USER"] {
      background: #0a3d62; align-self: flex-end;
    }
    .message[data-role="ASSISTANT"], .message[data-role="AGENT"] {
      background: #1a1a2e; align-self: flex-start;
    }
    .message[data-role="SYSTEM"] {
      background: #2d2d44; align-self: center; font-style: italic; font-size: 0.85rem;
    }
    .msg-role {
      font-size: 0.65rem; color: #e94560; text-transform: uppercase; font-weight: bold;
    }
    .msg-content { color: #ddd; margin: 0.2rem 0; white-space: pre-wrap; }
    .msg-time { font-size: 0.6rem; color: #555; }

    .chat-input {
      display: flex; gap: 0.5rem; margin-top: 0.5rem;
    }
    .input-message {
      flex: 1; background: #1a1a2e; border: 1px solid #333; border-radius: 8px;
      padding: 0.6rem 1rem; color: #eee; font-size: 0.9rem;
      &:focus { outline: none; border-color: #e94560; }
    }
    .btn-send {
      background: #e94560; color: white; border: none; border-radius: 8px;
      padding: 0.6rem 1.2rem; cursor: pointer; font-weight: bold;
      &:hover { background: #c73652; }
    }

    /* ─── Session List ────────────────────────── */
    .session-list {
      flex: 1; overflow-y: auto; padding: 0.5rem 0;
    }
    .session-card {
      display: flex; justify-content: space-between; align-items: center;
      background: #1a1a2e; border-radius: 8px; padding: 0.75rem; margin-bottom: 0.5rem;
      cursor: pointer;
      &:hover { background: #252545; }
    }
    .session-title { color: #ddd; }
    .session-date { color: #555; font-size: 0.75rem; }

    /* ─── Issues ──────────────────────────────── */
    .issue-card {
      background: #1a1a2e; border-radius: 8px; padding: 0.6rem; margin-bottom: 0.5rem;
      border-left: 3px solid #333;
    }
    .issue-card[data-priority="CRITICAL"] { border-left-color: #e94560; }
    .issue-card[data-priority="HIGH"] { border-left-color: #ff8c00; }
    .issue-card[data-priority="MEDIUM"] { border-left-color: #f0c040; }
    .issue-card[data-priority="LOW"] { border-left-color: #52b788; }

    .issue-header {
      display: flex; justify-content: space-between; margin-bottom: 0.25rem;
    }
    .issue-priority {
      font-size: 0.65rem; color: #888; text-transform: uppercase;
    }
    .issue-status {
      font-size: 0.65rem; padding: 1px 6px; border-radius: 8px;
      background: #333; color: #aaa;
    }
    .issue-title { color: #ccc; font-size: 0.85rem; }
    .issue-subs { color: #555; font-size: 0.7rem; display: block; margin-top: 0.25rem; }
  `,
})
export class ProjectPage implements OnInit, OnDestroy {
  private route = inject(ActivatedRoute);
  private api = inject(ApiService);
  private chatSocket = inject(ChatSocketService);

  project = signal<Project | null>(null);
  issues = signal<Issue[]>([]);
  sessions = signal<ChatSession[]>([]);
  activeSession = signal<ChatSession | null>(null);
  messages = signal<ChatMessage[]>([]);
  messageInput = '';

  private messageContainer = viewChild<ElementRef>('messageContainer');
  private socketSub: Subscription | null = null;

  constructor() {
    // Auto-scroll when messages change
    effect(() => {
      this.messages();
      setTimeout(() => this.scrollToBottom(), 50);
    });
  }

  ngOnInit() {
    const slug = this.route.snapshot.paramMap.get('slug');
    if (slug) {
      this.api.getProject(slug).subscribe((p) => {
        this.project.set(p);
        this.loadIssues(p.id);
        this.loadSessions(p.id);
      });
    }

    // Listen for WebSocket messages
    this.socketSub = this.chatSocket.newMessage$.subscribe((msg) => {
      this.messages.update((msgs) => [...msgs, msg]);
    });
  }

  ngOnDestroy() {
    this.chatSocket.leaveSession();
    this.socketSub?.unsubscribe();
  }

  loadIssues(projectId: string) {
    this.api.getIssues(projectId).subscribe((issues) => this.issues.set(issues));
  }

  loadSessions(projectId: string) {
    this.api.getChatSessions(projectId).subscribe((sessions) =>
      this.sessions.set(sessions),
    );
  }

  createSession() {
    const p = this.project();
    if (!p) return;
    this.api
      .createChatSession({ projectId: p.id, title: 'Neuer Chat' })
      .subscribe((session) => {
        this.sessions.update((s) => [session, ...s]);
        this.openSession(session);
      });
  }

  openSession(session: ChatSession) {
    this.activeSession.set(session);
    this.chatSocket.joinSession(session.id);
    this.api.getChatMessages(session.id).subscribe((msgs) => {
      this.messages.set(msgs);
    });
  }

  sendMessage() {
    const session = this.activeSession();
    const content = this.messageInput.trim();
    if (!session || !content) return;

    // Send via REST (WebSocket will broadcast back)
    this.api
      .sendChatMessage({
        chatSessionId: session.id,
        role: 'USER',
        content,
      })
      .subscribe((msg) => {
        this.messages.update((msgs) => [...msgs, msg]);
      });

    this.messageInput = '';
  }

  formatTime(dateStr: string): string {
    const date = new Date(dateStr);
    return date.toLocaleTimeString('de-DE', {
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  private scrollToBottom() {
    const el = this.messageContainer()?.nativeElement;
    if (el) el.scrollTop = el.scrollHeight;
  }
}
