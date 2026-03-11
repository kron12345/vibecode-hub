import { Component, inject, OnInit, OnDestroy, signal, computed } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  ApiService,
  Project,
  AgentsOverview,
  AgentRoleOverview,
  ActivityItem,
} from '../../services/api.service';
import { MonitorSocketService } from '../../services/monitor-socket.service';
import { IconComponent } from '../../components/icon.component';
import { HardwareMonitorComponent } from '../../components/hardware-monitor.component';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { TranslateService } from '../../services/translate.service';

const ROLE_META: Record<
  string,
  { icon: string; color: string; bgColor: string }
> = {
  INTERVIEWER: {
    icon: 'mic',
    color: 'text-sky-400',
    bgColor: 'bg-sky-500/20',
  },
  ARCHITECT: {
    icon: 'compass',
    color: 'text-violet-400',
    bgColor: 'bg-violet-500/20',
  },
  ISSUE_COMPILER: {
    icon: 'list-checks',
    color: 'text-amber-400',
    bgColor: 'bg-amber-500/20',
  },
  CODER: {
    icon: 'code-2',
    color: 'text-indigo-400',
    bgColor: 'bg-indigo-500/20',
  },
  CODE_REVIEWER: {
    icon: 'search-check',
    color: 'text-emerald-400',
    bgColor: 'bg-emerald-500/20',
  },
  UI_TESTER: {
    icon: 'monitor-check',
    color: 'text-pink-400',
    bgColor: 'bg-pink-500/20',
  },
  FUNCTIONAL_TESTER: {
    icon: 'test-tubes',
    color: 'text-teal-400',
    bgColor: 'bg-teal-500/20',
  },
  PEN_TESTER: {
    icon: 'shield-alert',
    color: 'text-red-400',
    bgColor: 'bg-red-500/20',
  },
  DOCUMENTER: {
    icon: 'file-text',
    color: 'text-cyan-400',
    bgColor: 'bg-cyan-500/20',
  },
  DEVOPS: {
    icon: 'server',
    color: 'text-orange-400',
    bgColor: 'bg-orange-500/20',
  },
};

const SHORT_ROLES: Record<string, string> = {
  INTERVIEWER: 'INT',
  ARCHITECT: 'ARCH',
  ISSUE_COMPILER: 'IC',
  CODER: 'CODE',
  CODE_REVIEWER: 'REV',
  UI_TESTER: 'UI',
  FUNCTIONAL_TESTER: 'FUNC',
  PEN_TESTER: 'PEN',
  DOCUMENTER: 'DOC',
  DEVOPS: 'OPS',
};

@Component({
  selector: 'app-dashboard',
  imports: [
    RouterLink,
    DatePipe,
    FormsModule,
    IconComponent,
    HardwareMonitorComponent,
    TranslatePipe,
  ],
  template: `
    <!-- Header -->
    <div
      class="flex items-center justify-between mb-6 animate-in stagger-1"
    >
      <div>
        <h1
          class="text-3xl font-extrabold tracking-tight bg-gradient-to-r from-white via-indigo-200 to-slate-500 bg-clip-text text-transparent"
        >
          {{ 'dashboard.title' | translate }}
        </h1>
        <div class="mt-2 h-1 w-16 bg-gradient-to-r from-sky-500 via-indigo-500 to-violet-500 rounded-full"></div>
        <p class="text-slate-500 mt-2">
          {{ 'dashboard.subtitle' | translate }}
        </p>
      </div>
      <div class="flex items-center gap-4">
        <div class="flex items-center gap-2">
          <span class="relative flex h-2.5 w-2.5">
            <span
              class="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"
            ></span>
            <span
              class="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"
            ></span>
          </span>
          <span
            class="text-[10px] font-mono text-emerald-400 uppercase tracking-widest"
            >Live</span
          >
        </div>
        <button
          (click)="showCreate = true"
          class="bg-indigo-600 hover:bg-indigo-500 hover:shadow-lg hover:shadow-indigo-500/25 text-white px-5 py-2.5 rounded-full font-bold transition-all duration-300 flex items-center gap-2 hover:scale-[1.03] text-sm"
        >
          <app-icon name="plus" [size]="16" />
          {{ 'dashboard.newProject' | translate }}
        </button>
      </div>
    </div>

    <!-- Quick Stats Strip -->
    <div
      class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6 animate-in stagger-2"
    >
      <div class="glass rounded-xl px-4 py-3.5 flex items-center gap-3 card-lift cursor-default">
        <div class="p-2.5 bg-indigo-500/15 rounded-xl">
          <app-icon name="folder-git-2" [size]="18" class="text-indigo-400" />
        </div>
        <div class="flex-1">
          <p
            class="text-[10px] text-slate-500 uppercase tracking-wider font-bold"
          >
            {{ 'dashboard.statProjects' | translate }}
          </p>
          <p class="text-xl font-mono font-bold text-white leading-tight">
            {{ projects().length }}
          </p>
        </div>
      </div>
      <div class="glass rounded-xl px-4 py-3.5 flex items-center gap-3 card-lift cursor-default">
        <div class="p-2.5 rounded-xl" [class]="workingAgents().length > 0 ? 'bg-emerald-500/15' : 'bg-slate-500/15'">
          <app-icon name="bot" [size]="18" [class]="workingAgents().length > 0 ? 'text-emerald-400' : 'text-slate-500'" />
        </div>
        <div class="flex-1">
          <p
            class="text-[10px] text-slate-500 uppercase tracking-wider font-bold"
          >
            {{ 'dashboard.statAgents' | translate }}
          </p>
          <div class="flex items-baseline gap-1">
            <p
              class="text-xl font-mono font-bold leading-tight"
              [class]="
                workingAgents().length > 0
                  ? 'text-emerald-400'
                  : 'text-slate-400'
              "
            >
              {{ workingAgents().length }}
            </p>
            <span class="text-slate-600 text-xs font-mono">/10</span>
          </div>
        </div>
      </div>
      <div class="glass rounded-xl px-4 py-3.5 flex items-center gap-3 card-lift cursor-default">
        <div class="p-2.5 bg-blue-500/15 rounded-xl relative">
          <app-icon name="play" [size]="18" class="text-blue-400" />
          @if ((taskStats()['RUNNING'] ?? 0) > 0) {
            <span class="absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full bg-blue-400 animate-pulse"></span>
          }
        </div>
        <div class="flex-1">
          <p
            class="text-[10px] text-slate-500 uppercase tracking-wider font-bold"
          >
            {{ 'dashboard.statRunning' | translate }}
          </p>
          <p
            class="text-xl font-mono font-bold text-blue-400 leading-tight"
          >
            {{ taskStats()['RUNNING'] ?? 0 }}
          </p>
        </div>
      </div>
      <div class="glass rounded-xl px-4 py-3.5 flex items-center gap-3 card-lift cursor-default">
        <div class="p-2.5 bg-violet-500/15 rounded-xl">
          <app-icon name="check-check" [size]="18" class="text-violet-400" />
        </div>
        <div class="flex-1">
          <p
            class="text-[10px] text-slate-500 uppercase tracking-wider font-bold"
          >
            {{ 'dashboard.statCompleted' | translate }}
          </p>
          <p
            class="text-xl font-mono font-bold text-violet-400 leading-tight"
          >
            {{ taskStats()['COMPLETED'] ?? 0 }}
          </p>
        </div>
      </div>
    </div>

    <!-- Main 2-Column Layout -->
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <!-- Left: Hardware + Activity (2/3) -->
      <div class="lg:col-span-2 space-y-4">
        <!-- Hardware Monitor -->
        <div class="animate-in stagger-3">
          <app-hardware-monitor layout="horizontal" />
        </div>

        <!-- Recent Activity -->
        <div
          class="glass rounded-2xl overflow-hidden animate-in stagger-5"
        >
          <div
            class="flex items-center justify-between px-5 py-3 border-b border-white/5"
          >
            <div class="flex items-center gap-2">
              <app-icon name="activity" [size]="14" class="text-slate-500" />
              <h3
                class="text-xs font-bold uppercase tracking-widest text-slate-400"
              >
                {{ 'dashboard.recentActivity' | translate }}
              </h3>
            </div>
            <a
              routerLink="/live-feed"
              class="text-[10px] text-indigo-400 hover:text-indigo-300 font-mono transition-colors"
            >
              {{ 'dashboard.viewAll' | translate }} &rarr;
            </a>
          </div>
          <div class="divide-y divide-white/[0.03]">
            @for (item of displayActivity(); track item.id) {
              <div
                class="px-5 py-2.5 flex items-center gap-3 hover:bg-white/[0.02] transition-colors border-l-2"
                [class]="item.agentRole ? accentBorder(item.agentRole) : 'border-l-slate-700'"
              >
                <div class="shrink-0">
                  @if (item.agentRole) {
                    <div class="p-1 rounded-md" [class]="getRoleMeta(item.agentRole).bgColor">
                      <app-icon
                        [name]="agentIcon(item.agentRole)"
                        [size]="12"
                        [class]="agentColor(item.agentRole)"
                      />
                    </div>
                  } @else {
                    <app-icon
                      name="circle-dot"
                      [size]="14"
                      class="text-slate-600"
                    />
                  }
                </div>
                <div class="flex-1 min-w-0">
                  <p class="text-xs text-slate-300 truncate">
                    @if (item.agentRole) {
                      <span
                        class="font-mono font-bold mr-1.5 text-[10px]"
                        [class]="agentColor(item.agentRole)"
                        >{{ shortRole(item.agentRole) }}</span
                      >
                    }
                    {{ item.message }}
                  </p>
                </div>
                @if (item.projectName) {
                  <span
                    class="text-[10px] text-slate-600 font-mono shrink-0 hidden sm:block bg-white/[0.03] px-1.5 py-0.5 rounded"
                    >{{ item.projectName }}</span
                  >
                }
                <span class="text-[10px] font-mono text-slate-600 shrink-0">
                  {{ item.createdAt | date: 'HH:mm' }}
                </span>
              </div>
            } @empty {
              <div class="px-5 py-10 text-center">
                <div class="p-3 bg-slate-800/50 rounded-2xl inline-block mb-3">
                  <app-icon
                    name="radio"
                    [size]="24"
                    class="text-slate-600"
                  />
                </div>
                <p class="text-xs text-slate-500">
                  {{ 'dashboard.noActivity' | translate }}
                </p>
                <p class="text-[10px] text-slate-600 mt-1">
                  Agent activity will appear here in real-time
                </p>
              </div>
            }
          </div>
        </div>
      </div>

      <!-- Right: Agents + Projects (1/3) -->
      <div class="space-y-4">
        <!-- Agent Pipeline Status -->
        <div class="glass rounded-2xl overflow-hidden animate-in stagger-4">
          <div class="flex items-center justify-between px-5 py-3 border-b border-white/5">
            <div class="flex items-center gap-2">
              <app-icon name="bot" [size]="14" class="text-indigo-400" />
              <h3
                class="text-xs font-bold uppercase tracking-widest text-slate-400"
              >
                {{ 'dashboard.agentStatus' | translate }}
              </h3>
            </div>
            <a
              routerLink="/agents"
              class="text-[10px] text-indigo-400 hover:text-indigo-300 font-mono transition-colors"
            >
              {{ 'dashboard.details' | translate }} &rarr;
            </a>
          </div>

          <!-- Pipeline grid: 5x2 -->
          <div class="grid grid-cols-5 gap-1 p-4">
            @for (role of pipelineRoles; track role) {
              @let meta = getRoleMeta(role);
              @let data = getRoleData(role);
              <div
                class="group relative flex flex-col items-center gap-1.5 py-2.5 px-1 rounded-xl transition-all duration-300 cursor-default"
                [class]="
                  data?.status === 'WORKING'
                    ? 'bg-white/[0.06] ring-1 ring-white/10'
                    : 'hover:bg-white/[0.02]'
                "
              >
                <div class="relative">
                  <div
                    class="p-2 rounded-xl transition-all duration-300"
                    [class]="
                      data?.status === 'WORKING'
                        ? meta.bgColor
                        : 'bg-slate-800/50'
                    "
                  >
                    <app-icon
                      [name]="meta.icon"
                      [size]="15"
                      [class]="
                        data?.status === 'WORKING'
                          ? meta.color
                          : 'text-slate-600'
                      "
                    />
                  </div>
                  @if (data?.status === 'WORKING') {
                    <span
                      class="absolute -top-0.5 -right-0.5 flex h-2.5 w-2.5"
                    >
                      <span
                        class="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75"
                        [class]="meta.bgColor.replace('/20', '/60')"
                      ></span>
                      <span
                        class="relative inline-flex rounded-full h-2.5 w-2.5"
                        [class]="meta.bgColor.replace('/20', '')"
                      ></span>
                    </span>
                  }
                </div>
                <span
                  class="text-[8px] font-mono leading-none text-center font-bold"
                  [class]="
                    data?.status === 'WORKING'
                      ? meta.color
                      : 'text-slate-600'
                  "
                >
                  {{ shortRole(role) }}
                </span>

                <!-- Tooltip on hover for working agents -->
                @if (data?.currentTask) {
                  <div
                    class="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-40 tooltip-glass rounded-xl p-2.5 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10"
                  >
                    <p class="text-[10px] font-bold text-slate-200 truncate">
                      {{ data!.currentTask.type }}
                    </p>
                    @if (data!.activeProjects.length) {
                      <p class="text-[9px] text-slate-500 truncate mt-0.5">
                        {{ data!.activeProjects[0].name }}
                      </p>
                    }
                  </div>
                }
              </div>
            }
          </div>

          <!-- Working agents detail list -->
          @if (workingAgents().length > 0) {
            <div class="px-4 pb-4 space-y-1.5">
              @for (agent of workingAgents(); track agent.role) {
                @let meta = getRoleMeta(agent.role);
                <div class="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-white/[0.02] border-l-2" [class]="accentBorder(agent.role)">
                  <app-icon
                    [name]="meta.icon"
                    [size]="12"
                    [class]="meta.color"
                  />
                  <span
                    class="text-[10px] font-mono text-slate-300 flex-1 truncate"
                  >
                    @if (agent.activeProjects.length) {
                      <a
                        [routerLink]="[
                          '/projects',
                          agent.activeProjects[0].slug,
                        ]"
                        class="hover:text-indigo-400 transition-colors"
                      >
                        {{ agent.activeProjects[0].name }}
                      </a>
                    }
                  </span>
                  @if (agent.currentTask) {
                    <span class="text-[9px] text-slate-600 font-mono bg-white/[0.03] px-1.5 py-0.5 rounded">{{
                      agent.currentTask.type
                    }}</span>
                  }
                </div>
              }
            </div>
          }
        </div>

        <!-- Active Projects -->
        <div class="glass rounded-2xl overflow-hidden animate-in stagger-6">
          <div class="flex items-center justify-between px-5 py-3 border-b border-white/5">
            <div class="flex items-center gap-2">
              <app-icon name="zap" [size]="14" class="text-amber-500" />
              <h3
                class="text-xs font-bold uppercase tracking-widest text-slate-400"
              >
                {{ 'dashboard.activeProjects' | translate }}
              </h3>
            </div>
            <a
              routerLink="/projects"
              class="text-[10px] text-indigo-400 hover:text-indigo-300 font-mono transition-colors"
            >
              {{ 'dashboard.viewAll' | translate }} &rarr;
            </a>
          </div>
          <div class="divide-y divide-white/[0.03]">
            @for (project of activeProjects(); track project.id) {
              <a
                [routerLink]="['/projects', project.slug]"
                class="flex items-center gap-3 px-5 py-3 hover:bg-white/[0.03] transition-all group"
              >
                <div
                  class="p-2 rounded-xl transition-colors"
                  [class]="project.status === 'INTERVIEWING' ? 'bg-sky-500/10 group-hover:bg-sky-500/20' : 'bg-amber-500/10 group-hover:bg-amber-500/20'"
                >
                  <app-icon
                    [name]="project.status === 'INTERVIEWING' ? 'mic' : 'settings'"
                    [size]="14"
                    [class]="project.status === 'INTERVIEWING' ? 'text-sky-400' : 'text-amber-400'"
                  />
                </div>
                <div class="flex-1 min-w-0">
                  <p
                    class="text-xs font-semibold text-white truncate group-hover:text-indigo-300 transition-colors"
                  >
                    {{ project.name }}
                  </p>
                  <span
                    class="text-[10px] font-mono"
                    [class]="statusColor(project.status)"
                    >{{ statusLabel(project.status) }}</span
                  >
                </div>
                <app-icon
                  name="chevron-right"
                  [size]="12"
                  class="text-slate-700 group-hover:text-indigo-400 transition-colors"
                />
              </a>
            } @empty {
              <div class="text-center py-8 px-5">
                <div class="p-3 bg-slate-800/50 rounded-2xl inline-block mb-3">
                  <app-icon
                    name="coffee"
                    [size]="20"
                    class="text-slate-600"
                  />
                </div>
                <p class="text-xs text-slate-500">
                  {{ 'dashboard.allIdle' | translate }}
                </p>
              </div>
            }
          </div>
        </div>

        <!-- Recent Projects (quick nav) -->
        @if (recentProjects().length > 0) {
          <div class="glass rounded-2xl overflow-hidden animate-in stagger-7">
            <div class="flex items-center gap-2 px-5 py-3 border-b border-white/5">
              <app-icon name="clock" [size]="14" class="text-slate-500" />
              <h3
                class="text-xs font-bold uppercase tracking-widest text-slate-400"
              >
                {{ 'dashboard.recentProjects' | translate }}
              </h3>
            </div>
            <div class="divide-y divide-white/[0.02]">
              @for (project of recentProjects(); track project.id) {
                <a
                  [routerLink]="['/projects', project.slug]"
                  class="flex items-center gap-2.5 px-5 py-2.5 hover:bg-white/[0.03] transition-colors group"
                >
                  <div class="h-1.5 w-1.5 rounded-full shrink-0" [class]="statusDot(project.status)"></div>
                  <span
                    class="text-xs text-slate-400 truncate flex-1 group-hover:text-slate-200 transition-colors"
                    >{{ project.name }}</span
                  >
                  <span class="text-[10px] font-mono text-slate-700">{{
                    formatDate(project.updatedAt)
                  }}</span>
                </a>
              }
            </div>
          </div>
        }
      </div>
    </div>

    <!-- Create Modal -->
    @if (showCreate) {
      <div
        class="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[100]"
        (click)="showCreate = false"
      >
        <div
          class="glass-heavy rounded-3xl p-8 w-full max-w-md shadow-2xl"
          (click)="$event.stopPropagation()"
        >
          <h2 class="text-xl font-bold text-white mb-2">
            {{ 'dashboard.newProjectTitle' | translate }}
          </h2>
          <p class="text-sm text-slate-500 mb-6">
            {{ 'dashboard.interviewHint' | translate }}
          </p>
          <div>
            <label
              class="text-xs text-slate-500 uppercase tracking-widest font-bold block mb-1.5"
              >{{ 'common.name' | translate }}</label
            >
            <input
              [(ngModel)]="newProjectName"
              (keydown.enter)="quickCreate()"
              class="w-full bg-slate-900/50 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500 transition-colors"
              [placeholder]="'dashboard.namePlaceholder' | translate"
            />
          </div>
          <div class="flex gap-3 justify-end mt-6">
            <button
              (click)="showCreate = false"
              class="px-5 py-2.5 rounded-xl border border-white/10 text-slate-400 hover:text-white hover:border-white/20 transition-all"
            >
              {{ 'common.cancel' | translate }}
            </button>
            <button
              (click)="quickCreate()"
              [disabled]="!newProjectName.trim()"
              class="px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
            >
              <app-icon name="message-circle" [size]="16" />
              {{ 'dashboard.startInterview' | translate }}
            </button>
          </div>
        </div>
      </div>
    }
  `,
})
export class DashboardPage implements OnInit, OnDestroy {
  private api = inject(ApiService);
  private router = inject(Router);
  private monitorSocket = inject(MonitorSocketService);
  i18n = inject(TranslateService);

  projects = signal<Project[]>([]);
  overview = signal<AgentsOverview | null>(null);
  restActivity = signal<ActivityItem[]>([]);
  showCreate = false;
  newProjectName = '';

  /** Pipeline order: left-to-right, top-to-bottom in the 5x2 grid */
  readonly pipelineRoles = [
    'INTERVIEWER',
    'ARCHITECT',
    'DEVOPS',
    'ISSUE_COMPILER',
    'CODER',
    'CODE_REVIEWER',
    'FUNCTIONAL_TESTER',
    'UI_TESTER',
    'PEN_TESTER',
    'DOCUMENTER',
  ];

  workingAgents = computed(() => {
    const ov = this.overview();
    if (!ov) return [];
    return ov.roles.filter((r) => r.status === 'WORKING');
  });

  taskStats = computed(() => {
    return this.overview()?.taskStats ?? {};
  });

  activeProjects = computed(() => {
    return this.projects().filter(
      (p) => p.status === 'INTERVIEWING' || p.status === 'SETTING_UP',
    );
  });

  recentProjects = computed(() => {
    const activeIds = new Set(this.activeProjects().map((p) => p.id));
    return this.projects()
      .filter((p) => !activeIds.has(p.id))
      .sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      )
      .slice(0, 5);
  });

  /** Merge REST history + live socket entries, cap at 8 */
  displayActivity = computed(() => {
    const rest = this.restActivity();
    const live = this.monitorSocket.logEntries();
    const existingIds = new Set(rest.map((i) => i.id));
    const newLive = live.filter((l) => !existingIds.has(l.id));
    return [...newLive, ...rest].slice(0, 8);
  });

  ngOnInit() {
    this.monitorSocket.connect();
    this.monitorSocket.joinLogRoom();

    this.api.getProjects().subscribe((p) => this.projects.set(p));
    this.api.getAgentsOverview().subscribe({
      next: (ov) => this.overview.set(ov),
      error: () => {},
    });
    this.api.getActivityFeed({ limit: 8 }).subscribe({
      next: (res) => this.restActivity.set(res.items),
      error: () => {},
    });
  }

  ngOnDestroy() {
    this.monitorSocket.leaveLogRoom();
  }

  quickCreate() {
    const name = this.newProjectName.trim();
    if (!name) return;
    this.api.quickCreateProject(name).subscribe((result) => {
      this.showCreate = false;
      this.newProjectName = '';
      this.router.navigate(['/projects', result.project.slug]);
    });
  }

  getRoleMeta(role: string) {
    return (
      ROLE_META[role] ?? {
        icon: 'bot',
        color: 'text-slate-400',
        bgColor: 'bg-slate-500/20',
      }
    );
  }

  getRoleData(role: string): AgentRoleOverview | undefined {
    return this.overview()?.roles.find((r) => r.role === role);
  }

  shortRole(role: string): string {
    return SHORT_ROLES[role] ?? role.slice(0, 3);
  }

  agentColor(role: string): string {
    return ROLE_META[role]?.color ?? 'text-slate-400';
  }

  agentIcon(role: string): string {
    return ROLE_META[role]?.icon ?? 'bot';
  }

  statusColor(status?: string): string {
    const map: Record<string, string> = {
      INTERVIEWING: 'text-sky-400',
      SETTING_UP: 'text-amber-400',
      READY: 'text-emerald-400',
      ARCHIVED: 'text-slate-500',
    };
    return map[status ?? ''] ?? 'text-slate-500';
  }

  statusLabel(status?: string): string {
    const map: Record<string, string> = {
      INTERVIEWING: this.i18n.t('project.interviewRunning'),
      SETTING_UP: this.i18n.t('project.settingUp'),
      READY: 'Ready',
      ARCHIVED: 'Archived',
    };
    return map[status ?? ''] ?? (status ?? '');
  }

  formatDate(dateStr: string): string {
    return new Date(dateStr).toLocaleDateString(this.i18n.dateLocale, {
      day: '2-digit',
      month: 'short',
    });
  }

  accentBorder(role: string): string {
    const map: Record<string, string> = {
      INTERVIEWER: 'border-l-sky-400',
      ARCHITECT: 'border-l-violet-400',
      ISSUE_COMPILER: 'border-l-amber-400',
      CODER: 'border-l-indigo-400',
      CODE_REVIEWER: 'border-l-emerald-400',
      UI_TESTER: 'border-l-pink-400',
      FUNCTIONAL_TESTER: 'border-l-teal-400',
      PEN_TESTER: 'border-l-red-400',
      DOCUMENTER: 'border-l-cyan-400',
      DEVOPS: 'border-l-orange-400',
    };
    return map[role] ?? 'border-l-slate-600';
  }

  statusDot(status?: string): string {
    const map: Record<string, string> = {
      INTERVIEWING: 'bg-sky-400',
      SETTING_UP: 'bg-amber-400',
      READY: 'bg-emerald-400',
      ARCHIVED: 'bg-slate-600',
    };
    return map[status ?? ''] ?? 'bg-slate-600';
  }
}
