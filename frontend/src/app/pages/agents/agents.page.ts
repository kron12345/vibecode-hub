import { Component, inject, OnInit, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { IconComponent } from '../../components/icon.component';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { ApiService, AgentRoleOverview, AgentsOverview } from '../../services/api.service';

const ROLE_META: Record<string, { icon: string; color: string; bgColor: string }> = {
  INTERVIEWER:       { icon: 'mic',            color: 'text-sky-400',     bgColor: 'bg-sky-500/20' },
  ARCHITECT:         { icon: 'compass',        color: 'text-violet-400',  bgColor: 'bg-violet-500/20' },
  ISSUE_COMPILER:    { icon: 'list-checks',    color: 'text-amber-400',   bgColor: 'bg-amber-500/20' },
  CODER:             { icon: 'code-2',         color: 'text-indigo-400',  bgColor: 'bg-indigo-500/20' },
  CODE_REVIEWER:     { icon: 'search-check',   color: 'text-emerald-400', bgColor: 'bg-emerald-500/20' },
  UI_TESTER:         { icon: 'monitor-check',  color: 'text-pink-400',    bgColor: 'bg-pink-500/20' },
  FUNCTIONAL_TESTER: { icon: 'test-tubes',     color: 'text-teal-400',    bgColor: 'bg-teal-500/20' },
  PEN_TESTER:        { icon: 'shield-alert',   color: 'text-red-400',     bgColor: 'bg-red-500/20' },
  DOCUMENTER:        { icon: 'file-text',      color: 'text-cyan-400',    bgColor: 'bg-cyan-500/20' },
  DEVOPS:            { icon: 'server',         color: 'text-orange-400',  bgColor: 'bg-orange-500/20' },
};

const ALL_ROLES = [
  'INTERVIEWER', 'ARCHITECT', 'ISSUE_COMPILER', 'CODER', 'CODE_REVIEWER',
  'UI_TESTER', 'FUNCTIONAL_TESTER', 'PEN_TESTER', 'DOCUMENTER', 'DEVOPS',
];

@Component({
  selector: 'app-agents',
  imports: [RouterLink, IconComponent, TranslatePipe],
  template: `
    <div class="space-y-6">
      <!-- Header -->
      <div class="flex items-center justify-between animate-in stagger-1">
        <div>
          <h1 class="text-3xl font-extrabold tracking-tight bg-gradient-to-r from-white via-violet-200 to-slate-500 bg-clip-text text-transparent">
            {{ 'agentsPage.title' | translate }}
          </h1>
          <p class="text-slate-500 mt-1">{{ 'agentsPage.subtitle' | translate }}</p>
        </div>
      </div>

      <!-- Summary Stats -->
      <div class="flex flex-wrap gap-4 animate-in stagger-2">
        <div class="glass rounded-2xl px-5 py-3 flex items-center gap-3">
          <div class="p-2 bg-violet-500/20 rounded-xl">
            <app-icon name="bot" [size]="16" class="text-violet-400" />
          </div>
          <div>
            <p class="text-xs text-slate-500">{{ 'agentsPage.totalRoles' | translate }}</p>
            <p class="text-lg font-mono font-bold text-white">10</p>
          </div>
        </div>
        <div class="glass rounded-2xl px-5 py-3 flex items-center gap-3">
          <div class="p-2 bg-emerald-500/20 rounded-xl">
            <app-icon name="play" [size]="16" class="text-emerald-400" />
          </div>
          <div>
            <p class="text-xs text-slate-500">{{ 'agentsPage.working' | translate }}</p>
            <p class="text-lg font-mono font-bold text-emerald-400">{{ workingCount() }}</p>
          </div>
        </div>
        <div class="glass rounded-2xl px-5 py-3 flex items-center gap-3">
          <div class="p-2 bg-indigo-500/20 rounded-xl">
            <app-icon name="check-check" [size]="16" class="text-indigo-400" />
          </div>
          <div>
            <p class="text-xs text-slate-500">{{ 'agentsPage.totalTasks' | translate }}</p>
            <p class="text-lg font-mono font-bold text-indigo-400">{{ totalTasks() }}</p>
          </div>
        </div>
      </div>

      <!-- Agent Role Cards -->
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        @for (role of allRoles; track role; let i = $index) {
          @let data = getRoleData(role);
          @let meta = getRoleMeta(role);
          <div
            class="glass rounded-2xl p-5 group hover:bg-white/[0.03] transition-all duration-300 animate-in"
            [style.animation-delay]="(0.3 + i * 0.06) + 's'"
          >
            <!-- Header -->
            <div class="flex items-center gap-3 mb-4">
              <div class="p-2.5 rounded-xl transition-colors" [class]="meta.bgColor">
                <app-icon [name]="meta.icon" [size]="20" [class]="meta.color" />
              </div>
              <div class="flex-1 min-w-0">
                <h3 class="text-sm font-bold text-white truncate">{{ 'agents.' + roleName(role) | translate }}</h3>
                <div class="flex items-center gap-1.5 mt-0.5">
                  @if (data?.status === 'WORKING') {
                    <span class="relative flex h-2 w-2">
                      <span class="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75" [class]="meta.bgColor.replace('/20', '/50')"></span>
                      <span class="relative inline-flex rounded-full h-2 w-2" [class]="meta.bgColor.replace('/20', '')"></span>
                    </span>
                    <span class="text-[10px] font-mono" [class]="meta.color">{{ 'agentsPage.statusWorking' | translate }}</span>
                  } @else {
                    <span class="h-2 w-2 rounded-full bg-slate-600"></span>
                    <span class="text-[10px] font-mono text-slate-500">{{ 'agentsPage.statusIdle' | translate }}</span>
                  }
                </div>
              </div>
            </div>

            <!-- Stats -->
            <div class="space-y-2">
              <div class="flex items-center justify-between">
                <span class="text-[10px] text-slate-500 uppercase tracking-wider">{{ 'agentsPage.tasks' | translate }}</span>
                <span class="text-xs font-mono text-slate-300">{{ data?.totalTasks ?? 0 }}</span>
              </div>

              @if (data?.activeProjects?.length) {
                <div>
                  <span class="text-[10px] text-slate-500 uppercase tracking-wider">{{ 'agentsPage.activeOn' | translate }}</span>
                  <div class="mt-1 flex flex-wrap gap-1">
                    @for (proj of data!.activeProjects; track proj.id) {
                      <a
                        [routerLink]="['/projects', proj.slug]"
                        class="text-[10px] px-2 py-0.5 rounded-full bg-white/5 text-slate-300 hover:text-indigo-400 hover:bg-indigo-500/10 transition-colors"
                      >
                        {{ proj.name }}
                      </a>
                    }
                  </div>
                </div>
              }

              @if (data?.currentTask) {
                <div class="mt-2 p-2 bg-white/[0.02] rounded-lg">
                  <p class="text-[10px] text-slate-500 uppercase tracking-wider mb-1">{{ 'agentsPage.currentTask' | translate }}</p>
                  <p class="text-xs text-slate-300 truncate">{{ data!.currentTask.type }}</p>
                  @if (data!.currentTask.issue) {
                    <p class="text-[10px] text-slate-500 truncate mt-0.5">↳ {{ data!.currentTask.issue.title }}</p>
                  }
                </div>
              }
            </div>
          </div>
        }
      </div>

      <!-- Task Stats Breakdown -->
      @if (overview(); as ov) {
        <div class="glass rounded-2xl p-6 animate-in stagger-5">
          <h3 class="text-sm font-bold text-white mb-4">{{ 'agentsPage.taskBreakdown' | translate }}</h3>
          <div class="flex flex-wrap gap-4">
            @for (entry of taskStatEntries(ov.taskStats); track entry[0]) {
              <div class="flex items-center gap-2">
                <span class="text-[10px] font-mono px-2 py-0.5 rounded" [class]="taskStatusColor(entry[0])">
                  {{ entry[0] }}
                </span>
                <span class="text-sm font-mono text-slate-300">{{ entry[1] }}</span>
              </div>
            }
          </div>
        </div>
      }
    </div>
  `,
})
export class AgentsPage implements OnInit {
  private api = inject(ApiService);

  overview = signal<AgentsOverview | null>(null);
  allRoles = ALL_ROLES;

  workingCount = signal(0);
  totalTasks = signal(0);

  ngOnInit() {
    this.api.getAgentsOverview().subscribe((ov) => {
      this.overview.set(ov);
      this.workingCount.set(
        ov.roles.filter((r) => r.status === 'WORKING').length,
      );
      this.totalTasks.set(
        ov.roles.reduce((sum, r) => sum + r.totalTasks, 0),
      );
    });
  }

  getRoleData(role: string): AgentRoleOverview | undefined {
    return this.overview()?.roles.find((r) => r.role === role);
  }

  getRoleMeta(role: string) {
    return ROLE_META[role] ?? { icon: 'bot', color: 'text-slate-400', bgColor: 'bg-slate-500/20' };
  }

  roleName(role: string): string {
    const map: Record<string, string> = {
      INTERVIEWER: 'interviewer',
      ARCHITECT: 'architect',
      ISSUE_COMPILER: 'issueCompiler',
      CODER: 'developer',
      CODE_REVIEWER: 'reviewer',
      UI_TESTER: 'uiTester',
      FUNCTIONAL_TESTER: 'functionalTester',
      PEN_TESTER: 'pentester',
      DOCUMENTER: 'docs',
      DEVOPS: 'devops',
    };
    return map[role] ?? role.toLowerCase();
  }

  taskStatEntries(stats: Record<string, number>): [string, number][] {
    return Object.entries(stats);
  }

  taskStatusColor(status: string): string {
    const map: Record<string, string> = {
      COMPLETED: 'text-emerald-400 bg-emerald-400/10',
      RUNNING: 'text-blue-400 bg-blue-400/10',
      PENDING: 'text-slate-400 bg-slate-400/10',
      FAILED: 'text-red-400 bg-red-400/10',
      CANCELLED: 'text-amber-400 bg-amber-400/10',
    };
    return map[status] ?? 'text-slate-400 bg-slate-400/10';
  }
}
