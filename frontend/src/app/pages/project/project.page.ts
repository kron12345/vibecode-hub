import {
  Component,
  inject,
  OnInit,
  OnDestroy,
  signal,
  viewChild,
  ElementRef,
  effect,
  computed,
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
import { IconComponent } from '../../components/icon.component';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { TranslateService } from '../../services/translate.service';

/** Agent role config — icon, color, i18n key */
const AGENT_CONFIG: Record<string, { icon: string; color: string; labelKey: string }> = {
  INTERVIEWER:       { icon: 'message-circle', color: 'sky', labelKey: 'agents.interviewer' },
  ARCHITECT:         { icon: 'pen-tool', color: 'violet', labelKey: 'agents.architect' },
  ISSUE_COMPILER:    { icon: 'list-checks', color: 'amber', labelKey: 'agents.issueCompiler' },
  CODER:             { icon: 'code-2', color: 'indigo', labelKey: 'agents.developer' },
  CODE_REVIEWER:     { icon: 'search-check', color: 'emerald', labelKey: 'agents.reviewer' },
  UI_TESTER:         { icon: 'monitor-check', color: 'pink', labelKey: 'agents.uiTester' },
  FUNCTIONAL_TESTER: { icon: 'test-tubes', color: 'teal', labelKey: 'agents.functionalTester' },
  PEN_TESTER:        { icon: 'shield-alert', color: 'red', labelKey: 'agents.pentester' },
  DOCUMENTER:        { icon: 'file-text', color: 'cyan', labelKey: 'agents.docs' },
  DEVOPS:            { icon: 'rocket', color: 'orange', labelKey: 'agents.devops' },
};

/** Issue status steps for progress dots */
const ISSUE_STEPS = ['OPEN', 'IN_PROGRESS', 'IN_REVIEW', 'TESTING', 'DONE', 'CLOSED'];

@Component({
  selector: 'app-project',
  imports: [FormsModule, RouterLink, IconComponent, TranslatePipe],
  template: `
    @if (project(); as p) {
      <!-- Header -->
      <div class="flex items-start justify-between mb-6">
        <div>
          <a routerLink="/" class="text-slate-500 text-sm hover:text-indigo-400 transition-colors flex items-center gap-1 mb-2">
            <app-icon name="arrow-left" [size]="14" /> {{ 'project.backToDashboard' | translate }}
          </a>
          <h1 class="text-3xl font-bold tracking-tight bg-gradient-to-r from-white to-slate-500 bg-clip-text text-transparent">
            {{ p.name }}
          </h1>
          <p class="text-slate-500 mt-1">
            {{ p.description }}
            @if (p.gitlabUrl) {
              <span class="mx-2 text-slate-700">·</span>
              <a [href]="p.gitlabUrl" target="_blank" class="text-indigo-400 hover:text-indigo-300 font-mono text-sm">
                <app-icon name="git-branch" [size]="12" class="inline" /> GitLab
              </a>
            }
            @if (p.previewPort) {
              <span class="mx-2 text-slate-700">·</span>
              <a [href]="'https://' + p.slug + '.hub.example.com'" target="_blank" class="text-emerald-400 hover:text-emerald-300 font-mono text-sm">
                <app-icon name="globe" [size]="12" class="inline" /> {{ 'project.previewUrl' | translate }}
              </a>
            }
          </p>
        </div>
      </div>

      <!-- Agent Pipeline -->
      <div class="glass rounded-[2rem] p-6 mb-6 relative overflow-hidden">
        <div class="flex items-center justify-between mb-4">
          <h2 class="text-sm font-bold text-slate-500 uppercase tracking-widest">{{ 'project.agentPipeline' | translate }}</h2>
          @if (hasWorkingAgent()) {
            <span class="text-[10px] text-indigo-400 font-mono animate-pulse uppercase tracking-widest">{{ 'project.processing' | translate }}</span>
          }
        </div>

        <div class="relative flex items-center justify-between gap-4">
          <!-- Connection Line -->
          <div class="absolute top-1/2 left-0 w-full h-[2px] bg-slate-800 -translate-y-1/2 z-0"></div>
          @if (hasWorkingAgent()) {
            <div class="absolute top-1/2 left-0 w-full h-[2px] -translate-y-1/2 z-0 pulse-line"></div>
          }

          <!-- Agent Cards -->
          @for (entry of agentEntries(); track entry.role) {
            <div
              class="flex-1 glass p-4 rounded-2xl z-10 transition-all duration-500 border border-transparent"
              [class]="entry.instance?.status === 'WORKING' ? 'agent-glow-' + entry.color + ' -translate-y-1' : 'opacity-50'"
            >
              <div class="flex items-center gap-3 mb-2">
                <div
                  class="p-2.5 rounded-xl"
                  [class]="'bg-' + entry.color + '-500/20 text-' + entry.color + '-400'"
                >
                  @if (entry.instance?.status === 'WORKING') {
                    <div class="activity-ring">
                      <app-icon [name]="entry.icon" [size]="18" />
                    </div>
                  } @else {
                    <app-icon [name]="entry.icon" [size]="18" />
                  }
                </div>
                <span class="font-semibold text-sm text-white">{{ entry.labelKey | translate }}</span>
              </div>
              <p class="text-[10px] text-slate-600 font-mono mb-2">
                {{ entry.instance?.provider ?? ('project.notAssigned' | translate) }}
                @if (entry.instance?.model) {
                  · {{ entry.instance!.model }}
                }
              </p>
              @if (entry.instance?.status === 'WORKING') {
                <span class="text-[10px] font-mono animate-pulse uppercase tracking-widest"
                  [class]="'text-' + entry.color + '-400'"
                >
                  {{ 'project.working' | translate }}
                </span>
              } @else if (entry.instance) {
                <span class="text-[10px] text-slate-600 font-mono uppercase">{{ entry.instance.status }}</span>
              }
            </div>
          }
        </div>
      </div>

      <!-- Main Content: Issues + Chat/Terminal -->
      <div class="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-4">

        <!-- Left: Issues -->
        <div class="glass rounded-3xl p-5 max-h-[65vh] overflow-y-auto">
          <div class="flex items-center justify-between mb-4">
            <h3 class="text-sm font-bold text-slate-500 uppercase tracking-widest">{{ 'project.issues' | translate }}</h3>
            <span class="text-[10px] font-mono text-slate-600">{{ issues().length }}</span>
          </div>
          @for (issue of issues(); track issue.id) {
            <div
              class="bg-black/30 rounded-xl p-3 mb-2 border-l-2 transition-all hover:bg-black/40"
              [class]="issueBorderClass(issue.priority)"
            >
              <div class="flex items-center justify-between mb-1">
                <span class="text-[10px] uppercase tracking-widest font-bold"
                  [class]="issuePriorityColor(issue.priority)"
                >
                  {{ issue.priority }}
                </span>
                <span class="text-[9px] font-mono text-slate-600 uppercase">{{ issue.status }}</span>
              </div>
              <p class="text-sm text-slate-300 mb-2">{{ issue.title }}</p>
              <!-- Progress dots -->
              <div class="progress-dots">
                @for (step of issueSteps; track step; let i = $index) {
                  <span
                    class="dot"
                    [class.done]="getStepIndex(issue.status) > i"
                    [class.active]="getStepIndex(issue.status) === i"
                  ></span>
                }
              </div>
              @if (issue.subIssues && issue.subIssues.length > 0) {
                <span class="text-[10px] text-slate-600 mt-1 block">
                  {{ i18n.t('project.subIssues', { count: issue.subIssues.length }) }}
                </span>
              }
            </div>
          }
          @if (issues().length === 0) {
            <p class="text-slate-600 text-sm text-center py-8">{{ 'project.noIssues' | translate }}</p>
          }
        </div>

        <!-- Right: Chat Terminal -->
        <div class="glass rounded-3xl flex flex-col max-h-[65vh]">
          <!-- Session bar -->
          <div class="flex items-center justify-between px-5 py-3 border-b border-white/5">
            <div class="flex items-center gap-3">
              <div class="terminal-dots">
                <span></span><span></span><span></span>
              </div>
              @if (activeSession()) {
                <span class="text-[10px] font-mono text-slate-500 uppercase tracking-widest">
                  {{ activeSession()!.title }}
                </span>
              } @else {
                <span class="text-[10px] font-mono text-slate-500 uppercase tracking-widest">
                  {{ 'project.liveSystemFeed' | translate }}
                </span>
              }
            </div>
            <div class="flex items-center gap-2">
              @if (activeSession()) {
                <button
                  (click)="closeSession()"
                  class="text-slate-600 hover:text-slate-400 transition-colors"
                  [title]="'project.closeSession' | translate"
                >
                  <app-icon name="x" [size]="14" />
                </button>
              }
              <button
                (click)="createSession()"
                class="text-slate-600 hover:text-indigo-400 transition-colors"
                [title]="'project.newChat' | translate"
              >
                <app-icon name="plus" [size]="14" />
              </button>
            </div>
          </div>

          @if (activeSession()) {
            <!-- Messages -->
            <div class="flex-1 overflow-y-auto p-5 font-mono text-sm space-y-1.5" #messageContainer>
              @for (msg of messages(); track msg.id) {
                <div class="flex gap-2">
                  <span class="text-slate-700 shrink-0">[{{ formatTime(msg.createdAt) }}]</span>
                  @switch (msg.role) {
                    @case ('USER') {
                      <span class="text-white"><span class="text-indigo-500">></span> {{ msg.content }}</span>
                    }
                    @case ('ASSISTANT') {
                      <span class="text-indigo-400">{{ msg.content }}</span>
                    }
                    @case ('AGENT') {
                      <span class="text-emerald-400">{{ msg.content }}</span>
                    }
                    @case ('SYSTEM') {
                      <span class="text-slate-500 italic">{{ msg.content }}</span>
                    }
                  }
                </div>
              }
              @if (messages().length === 0) {
                <p class="text-indigo-500">> {{ 'project.systemReady' | translate }}</p>
              }
            </div>

            <!-- Input -->
            <div class="px-5 py-3 border-t border-white/5">
              <div class="flex items-center gap-2 bg-black/40 rounded-xl px-4 py-2.5">
                <span class="text-indigo-500 font-mono text-sm shrink-0">></span>
                <input
                  type="text"
                  [(ngModel)]="messageInput"
                  (keydown.enter)="sendMessage()"
                  [placeholder]="'project.chatPlaceholder' | translate"
                  class="flex-1 bg-transparent border-none outline-none text-white font-mono text-sm placeholder-slate-600"
                />
                <button
                  (click)="sendMessage()"
                  class="text-slate-600 hover:text-indigo-400 transition-colors shrink-0"
                >
                  <app-icon name="send-horizontal" [size]="16" />
                </button>
              </div>
            </div>
          } @else {
            <!-- Session list -->
            <div class="flex-1 overflow-y-auto p-5">
              @for (s of sessions(); track s.id) {
                <div
                  class="flex items-center justify-between bg-black/30 rounded-xl p-3 mb-2 cursor-pointer hover:bg-black/40 transition-colors"
                  (click)="openSession(s)"
                >
                  <div class="flex items-center gap-3">
                    <app-icon name="message-square" [size]="14" class="text-slate-600" />
                    <span class="text-sm text-slate-300">{{ s.title }}</span>
                  </div>
                  <span class="text-[10px] font-mono text-slate-600">{{ formatTime(s.updatedAt) }}</span>
                </div>
              }
              @if (sessions().length === 0) {
                <div class="text-center py-12">
                  <app-icon name="message-square-plus" [size]="32" class="text-slate-700 mx-auto mb-3" />
                  <p class="text-slate-600 text-sm">{{ 'project.startNewChat' | translate }}</p>
                </div>
              }
            </div>
          }
        </div>
      </div>
    } @else {
      <!-- Skeleton Loading -->
      <div class="space-y-6">
        <div class="skeleton h-10 w-1/3"></div>
        <div class="skeleton h-5 w-1/2"></div>
        <div class="glass rounded-[2rem] p-6">
          <div class="flex gap-4">
            @for (i of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]; track i) {
              <div class="flex-1 skeleton h-28 rounded-2xl"></div>
            }
          </div>
        </div>
        <div class="grid grid-cols-[280px_1fr] gap-4">
          <div class="skeleton h-96 rounded-3xl"></div>
          <div class="skeleton h-96 rounded-3xl"></div>
        </div>
      </div>
    }
  `,
})
export class ProjectPage implements OnInit, OnDestroy {
  private route = inject(ActivatedRoute);
  private api = inject(ApiService);
  private chatSocket = inject(ChatSocketService);
  i18n = inject(TranslateService);

  project = signal<Project | null>(null);
  issues = signal<Issue[]>([]);
  sessions = signal<ChatSession[]>([]);
  activeSession = signal<ChatSession | null>(null);
  messages = signal<ChatMessage[]>([]);
  messageInput = '';
  issueSteps = ISSUE_STEPS;

  private messageContainer = viewChild<ElementRef>('messageContainer');
  private socketSub: Subscription | null = null;
  private agentStatusSub: Subscription | null = null;
  private projectUpdatedSub: Subscription | null = null;

  /** Build agent entries from the 6 roles, filling in instance data if available */
  agentEntries = computed(() => {
    const agents = this.project()?.agents ?? [];
    return Object.entries(AGENT_CONFIG).map(([role, cfg]) => ({
      role,
      ...cfg,
      instance: agents.find((a) => a.role === role),
    }));
  });

  hasWorkingAgent = computed(() =>
    (this.project()?.agents ?? []).some((a) => a.status === 'WORKING'),
  );

  constructor() {
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

        // Auto-open interview session if project is in INTERVIEWING state
        if (p.status === 'INTERVIEWING') {
          this.api.getChatSessions(p.id).subscribe((sessions) => {
            const interviewSession = sessions.find(
              (s) => s.title === 'Project Interview',
            );
            if (interviewSession) {
              this.openSession(interviewSession);
            }
          });
        }
      });
    }

    this.socketSub = this.chatSocket.newMessage$.subscribe((msg) => {
      this.messages.update((msgs) => [...msgs, msg]);
    });

    // Listen for agent status changes to update pipeline visualization
    this.agentStatusSub = this.chatSocket.agentStatus$.subscribe((event) => {
      const p = this.project();
      if (p && event.projectId === p.id) {
        // Reload project to get updated agent statuses
        this.api.getProject(p.slug).subscribe((updated) => {
          this.project.set(updated);
        });
      }
    });

    // Listen for project updates (e.g., interview complete)
    this.projectUpdatedSub = this.chatSocket.projectUpdated$.subscribe(
      (event) => {
        const p = this.project();
        if (p && event.projectId === p.id) {
          this.api.getProject(p.slug).subscribe((updated) => {
            this.project.set(updated);
          });
        }
      },
    );
  }

  ngOnDestroy() {
    this.chatSocket.leaveSession();
    this.socketSub?.unsubscribe();
    this.agentStatusSub?.unsubscribe();
    this.projectUpdatedSub?.unsubscribe();
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
      .createChatSession({ projectId: p.id, title: this.i18n.t('project.newChat') })
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

  closeSession() {
    this.chatSocket.leaveSession();
    this.activeSession.set(null);
    this.messages.set([]);
  }

  sendMessage() {
    const session = this.activeSession();
    const content = this.messageInput.trim();
    if (!session || !content) return;

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
    return new Date(dateStr).toLocaleTimeString(this.i18n.dateLocale, {
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  getStepIndex(status: string): number {
    return ISSUE_STEPS.indexOf(status);
  }

  issueBorderClass(priority: string): string {
    switch (priority) {
      case 'CRITICAL': return 'border-l-rose-500';
      case 'HIGH': return 'border-l-amber-500';
      case 'MEDIUM': return 'border-l-yellow-500';
      case 'LOW': return 'border-l-emerald-500';
      default: return 'border-l-slate-700';
    }
  }

  issuePriorityColor(priority: string): string {
    switch (priority) {
      case 'CRITICAL': return 'text-rose-400';
      case 'HIGH': return 'text-amber-400';
      case 'MEDIUM': return 'text-yellow-400';
      case 'LOW': return 'text-emerald-400';
      default: return 'text-slate-400';
    }
  }

  private scrollToBottom() {
    const el = this.messageContainer()?.nativeElement;
    if (el) el.scrollTop = el.scrollHeight;
  }
}
