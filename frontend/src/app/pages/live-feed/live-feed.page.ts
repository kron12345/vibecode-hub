import { Component, inject, OnInit, OnDestroy, signal, computed } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { IconComponent } from '../../components/icon.component';
import { HardwareMonitorComponent } from '../../components/hardware-monitor.component';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { ApiService, ActivityItem, Project } from '../../services/api.service';
import { MonitorSocketService } from '../../services/monitor-socket.service';

const AGENT_COLORS: Record<string, string> = {
  INTERVIEWER: 'text-sky-400',
  ARCHITECT: 'text-violet-400',
  ISSUE_COMPILER: 'text-amber-400',
  CODER: 'text-indigo-400',
  CODE_REVIEWER: 'text-emerald-400',
  UI_TESTER: 'text-pink-400',
  FUNCTIONAL_TESTER: 'text-teal-400',
  PEN_TESTER: 'text-red-400',
  DOCUMENTER: 'text-cyan-400',
  DEVOPS: 'text-orange-400',
};

const AGENT_ICONS: Record<string, string> = {
  INTERVIEWER: 'mic',
  ARCHITECT: 'compass',
  ISSUE_COMPILER: 'list-checks',
  CODER: 'code-2',
  CODE_REVIEWER: 'search-check',
  UI_TESTER: 'monitor-check',
  FUNCTIONAL_TESTER: 'test-tubes',
  PEN_TESTER: 'shield-alert',
  DOCUMENTER: 'file-text',
  DEVOPS: 'server',
};

const LEVEL_COLORS: Record<string, string> = {
  DEBUG: 'text-slate-500',
  INFO: 'text-blue-400',
  WARN: 'text-amber-400',
  ERROR: 'text-red-400',
};

@Component({
  selector: 'app-live-feed',
  imports: [
    DatePipe,
    FormsModule,
    RouterLink,
    IconComponent,
    HardwareMonitorComponent,
    TranslatePipe,
  ],
  template: `
    <div class="space-y-6">
      <!-- Header -->
      <div class="flex items-center justify-between animate-in stagger-1">
        <div>
          <h1 class="text-3xl font-extrabold tracking-tight bg-gradient-to-r from-white via-emerald-200 to-slate-500 bg-clip-text text-transparent">
            {{ 'liveFeed.title' | translate }}
          </h1>
          <p class="text-slate-500 mt-1">{{ 'liveFeed.subtitle' | translate }}</p>
        </div>
        <div class="flex items-center gap-2">
          <span class="relative flex h-3 w-3">
            <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
            <span class="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
          </span>
          <span class="text-xs text-emerald-400 font-mono">LIVE</span>
        </div>
      </div>

      <!-- Hardware Monitor -->
      <div class="animate-in stagger-2">
        <app-hardware-monitor layout="horizontal" />
      </div>

      <!-- Filters -->
      <div class="flex flex-wrap gap-3 animate-in stagger-3">
        <select
          class="glass px-3 py-2 rounded-xl text-sm text-slate-300 bg-transparent border border-white/5 focus:border-indigo-500/50 outline-none"
          [(ngModel)]="filterProject"
          (ngModelChange)="loadActivity()"
        >
          <option value="">{{ 'liveFeed.allProjects' | translate }}</option>
          @for (p of projects(); track p.id) {
            <option [value]="p.id">{{ p.name }}</option>
          }
        </select>
        <select
          class="glass px-3 py-2 rounded-xl text-sm text-slate-300 bg-transparent border border-white/5 focus:border-indigo-500/50 outline-none"
          [(ngModel)]="filterRole"
          (ngModelChange)="applyFilter()"
        >
          <option value="">{{ 'liveFeed.allAgents' | translate }}</option>
          @for (role of agentRoles; track role) {
            <option [value]="role">{{ role }}</option>
          }
        </select>
        <select
          class="glass px-3 py-2 rounded-xl text-sm text-slate-300 bg-transparent border border-white/5 focus:border-indigo-500/50 outline-none"
          [(ngModel)]="filterLevel"
          (ngModelChange)="applyFilter()"
        >
          <option value="">{{ 'liveFeed.allLevels' | translate }}</option>
          <option value="INFO">INFO</option>
          <option value="WARN">WARN</option>
          <option value="ERROR">ERROR</option>
        </select>
      </div>

      <!-- Activity Stream -->
      <div class="space-y-2 animate-in stagger-4">
        @for (item of filteredItems(); track item.id; let i = $index) {
          <div class="glass rounded-xl px-4 py-3 flex items-start gap-3 hover:bg-white/[0.03] transition-colors animate-in"
               [style.animation-delay]="(0.05 * Math.min(i, 20)) + 's'">
            <!-- Agent Icon -->
            <div class="mt-0.5 shrink-0">
              @if (item.agentRole) {
                <app-icon [name]="agentIcon(item.agentRole)" [size]="16" [class]="agentColor(item.agentRole)" />
              } @else {
                <app-icon name="circle-dot" [size]="16" class="text-slate-500" />
              }
            </div>

            <!-- Content -->
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                @if (item.agentRole) {
                  <span class="text-xs font-mono font-bold" [class]="agentColor(item.agentRole)">
                    {{ item.agentRole }}
                  </span>
                }
                @if (item.level) {
                  <span class="text-[10px] font-mono px-1.5 py-0.5 rounded" [class]="levelColor(item.level)">
                    {{ item.level }}
                  </span>
                }
                @if (item.type === 'comment') {
                  <span class="text-[10px] font-mono text-purple-400 bg-purple-400/10 px-1.5 py-0.5 rounded">COMMENT</span>
                }
                @if (item.type === 'message') {
                  <span class="text-[10px] font-mono text-blue-400 bg-blue-400/10 px-1.5 py-0.5 rounded">CHAT</span>
                }
                @if (item.projectName) {
                  <a [routerLink]="['/projects', item.projectSlug]" class="text-[10px] text-slate-500 hover:text-indigo-400 transition-colors">
                    {{ item.projectName }}
                  </a>
                }
              </div>
              <p class="text-sm text-slate-300 mt-1 break-words">{{ item.message }}</p>
              @if (item.issueTitle) {
                <p class="text-xs text-slate-500 mt-0.5">↳ {{ item.issueTitle }}</p>
              }
            </div>

            <!-- Timestamp -->
            <span class="text-[10px] font-mono text-slate-600 whitespace-nowrap shrink-0 mt-0.5">
              {{ item.createdAt | date:'HH:mm:ss' }}
            </span>
          </div>
        } @empty {
          <div class="glass rounded-2xl p-12 text-center">
            <app-icon name="radio" [size]="32" class="text-slate-600 mx-auto mb-3" />
            <p class="text-slate-500">{{ 'liveFeed.noActivity' | translate }}</p>
          </div>
        }

        <!-- Load More -->
        @if (hasMore()) {
          <button
            (click)="loadMore()"
            class="w-full glass rounded-xl py-3 text-sm text-slate-400 hover:text-white hover:bg-white/5 transition-colors"
          >
            {{ 'liveFeed.loadMore' | translate }}
          </button>
        }
      </div>
    </div>
  `,
})
export class LiveFeedPage implements OnInit, OnDestroy {
  private api = inject(ApiService);
  private monitorSocket = inject(MonitorSocketService);

  projects = signal<Project[]>([]);
  allItems = signal<ActivityItem[]>([]);
  hasMore = signal(false);
  Math = Math;

  filterProject = '';
  filterRole = '';
  filterLevel = '';
  private offset = 0;

  readonly agentRoles = [
    'INTERVIEWER', 'ARCHITECT', 'ISSUE_COMPILER', 'CODER',
    'CODE_REVIEWER', 'UI_TESTER', 'FUNCTIONAL_TESTER',
    'PEN_TESTER', 'DOCUMENTER', 'DEVOPS',
  ];

  filteredItems = computed(() => {
    let items = this.allItems();
    if (this.filterRole) {
      items = items.filter((i) => i.agentRole === this.filterRole);
    }
    if (this.filterLevel) {
      items = items.filter((i) => i.level === this.filterLevel);
    }
    // Merge live entries from socket
    const live = this.monitorSocket.logEntries();
    if (live.length > 0) {
      const existingIds = new Set(items.map((i) => i.id));
      const newOnes = live.filter((l) => !existingIds.has(l.id));
      items = [...newOnes, ...items];
    }
    return items;
  });

  ngOnInit() {
    this.monitorSocket.connect();
    this.monitorSocket.joinLogRoom();

    this.api.getProjects().subscribe((p) => this.projects.set(p));
    this.loadActivity();
  }

  ngOnDestroy() {
    this.monitorSocket.leaveLogRoom();
  }

  loadActivity() {
    this.offset = 0;
    const params: any = { limit: 50, offset: 0 };
    if (this.filterProject) params.projectId = this.filterProject;

    this.api.getActivityFeed(params).subscribe((res) => {
      this.allItems.set(res.items);
      this.hasMore.set(res.items.length < res.total);
    });
  }

  loadMore() {
    this.offset += 50;
    const params: any = { limit: 50, offset: this.offset };
    if (this.filterProject) params.projectId = this.filterProject;

    this.api.getActivityFeed(params).subscribe((res) => {
      this.allItems.update((prev) => [...prev, ...res.items]);
      this.hasMore.set(this.offset + 50 < res.total);
    });
  }

  applyFilter() {
    // Client-side filter — filteredItems computed handles it
  }

  agentColor(role: string): string {
    return AGENT_COLORS[role] ?? 'text-slate-400';
  }

  agentIcon(role: string): string {
    return AGENT_ICONS[role] ?? 'bot';
  }

  levelColor(level: string): string {
    return LEVEL_COLORS[level] ?? 'text-slate-400';
  }
}
