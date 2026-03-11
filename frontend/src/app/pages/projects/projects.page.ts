import { Component, inject, OnInit, signal, computed } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { IconComponent } from '../../components/icon.component';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { TranslateService } from '../../services/translate.service';
import { ApiService, Project } from '../../services/api.service';

const STATUS_COLORS: Record<string, string> = {
  INTERVIEWING: 'text-sky-400 bg-sky-400/10',
  SETTING_UP: 'text-amber-400 bg-amber-400/10',
  READY: 'text-emerald-400 bg-emerald-400/10',
  ARCHIVED: 'text-slate-500 bg-slate-500/10',
};

const STATUS_ICONS: Record<string, string> = {
  INTERVIEWING: 'mic',
  SETTING_UP: 'settings',
  READY: 'check-circle',
  ARCHIVED: 'archive',
};

@Component({
  selector: 'app-projects',
  imports: [DatePipe, FormsModule, RouterLink, IconComponent, TranslatePipe],
  template: `
    <div class="space-y-6">
      <!-- Header -->
      <div class="flex items-center justify-between animate-in stagger-1">
        <div>
          <h1 class="text-3xl font-extrabold tracking-tight bg-gradient-to-r from-white via-indigo-200 to-slate-500 bg-clip-text text-transparent">
            {{ 'projectsList.title' | translate }}
          </h1>
          <p class="text-slate-500 mt-1">{{ i18n.t('projectsList.count', { count: projects().length }) }}</p>
        </div>
      </div>

      <!-- Stats Summary -->
      <div class="grid grid-cols-3 gap-3 animate-in stagger-2">
        <div class="glass rounded-xl px-4 py-3.5 flex items-center gap-3 card-lift cursor-default">
          <div class="p-2.5 bg-indigo-500/15 rounded-xl">
            <app-icon name="folder-git-2" [size]="18" class="text-indigo-400" />
          </div>
          <div>
            <p class="text-[10px] text-slate-500 uppercase tracking-wider font-bold">{{ 'projectsList.total' | translate }}</p>
            <p class="text-xl font-mono font-bold text-white">{{ projects().length }}</p>
          </div>
        </div>
        <div class="glass rounded-xl px-4 py-3.5 flex items-center gap-3 card-lift cursor-default">
          <div class="p-2.5 bg-emerald-500/15 rounded-xl">
            <app-icon name="check-circle" [size]="18" class="text-emerald-400" />
          </div>
          <div>
            <p class="text-[10px] text-slate-500 uppercase tracking-wider font-bold">{{ 'projectsList.ready' | translate }}</p>
            <p class="text-xl font-mono font-bold text-emerald-400">{{ countByStatus('READY') }}</p>
          </div>
        </div>
        <div class="glass rounded-xl px-4 py-3.5 flex items-center gap-3 card-lift cursor-default">
          <div class="p-2.5 bg-sky-500/15 rounded-xl">
            <app-icon name="activity" [size]="18" class="text-sky-400" />
          </div>
          <div>
            <p class="text-[10px] text-slate-500 uppercase tracking-wider font-bold">{{ 'projectsList.active' | translate }}</p>
            <p class="text-xl font-mono font-bold text-sky-400">{{ countByStatus('INTERVIEWING') + countByStatus('SETTING_UP') }}</p>
          </div>
        </div>
      </div>

      <!-- Filter + Search -->
      <div class="flex flex-wrap gap-3 animate-in stagger-3">
        <div class="flex-1 min-w-[200px]">
          <div class="glass rounded-xl flex items-center gap-2 px-3 py-2 border border-white/5 focus-within:border-indigo-500/50">
            <app-icon name="search" [size]="16" class="text-slate-500" />
            <input
              type="text"
              [(ngModel)]="searchQuery"
              [placeholder]="'projectsList.search' | translate"
              class="bg-transparent text-sm text-slate-300 placeholder:text-slate-600 outline-none flex-1"
            />
          </div>
        </div>
        <select
          class="glass px-3 py-2 rounded-xl text-sm text-slate-300 bg-transparent border border-white/5 focus:border-indigo-500/50 outline-none"
          [(ngModel)]="filterStatus"
        >
          <option value="">{{ 'projectsList.allStatuses' | translate }}</option>
          <option value="INTERVIEWING">Interviewing</option>
          <option value="SETTING_UP">Setting Up</option>
          <option value="READY">Ready</option>
          <option value="ARCHIVED">Archived</option>
        </select>
        <select
          class="glass px-3 py-2 rounded-xl text-sm text-slate-300 bg-transparent border border-white/5 focus:border-indigo-500/50 outline-none"
          [(ngModel)]="sortField"
        >
          <option value="updatedAt">{{ 'projectsList.sortActivity' | translate }}</option>
          <option value="name">{{ 'projectsList.sortName' | translate }}</option>
          <option value="createdAt">{{ 'projectsList.sortCreated' | translate }}</option>
        </select>
      </div>

      <!-- Project Table -->
      <div class="glass rounded-2xl overflow-hidden animate-in stagger-4">
        <table class="w-full">
          <thead>
            <tr class="border-b border-white/5">
              <th class="text-left px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-slate-500">{{ 'projectsList.colName' | translate }}</th>
              <th class="text-left px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-slate-500">{{ 'projectsList.colStatus' | translate }}</th>
              <th class="text-left px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-slate-500 hidden md:table-cell">{{ 'projectsList.colSlug' | translate }}</th>
              <th class="text-left px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-slate-500 hidden lg:table-cell">{{ 'projectsList.colUpdated' | translate }}</th>
              <th class="text-right px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-slate-500 w-12"></th>
            </tr>
          </thead>
          <tbody>
            @for (project of filtered(); track project.id; let i = $index) {
              <tr
                class="border-b border-white/[0.02] hover:bg-white/[0.03] transition-colors cursor-pointer group"
              >
                <td class="px-4 py-3.5">
                  <a [routerLink]="['/projects', project.slug]" class="flex items-center gap-3">
                    <div class="p-2 rounded-xl transition-all duration-300 border"
                         [class]="project.status === 'READY' ? 'bg-emerald-500/10 border-emerald-500/20 group-hover:bg-emerald-500/20' :
                                  project.status === 'INTERVIEWING' ? 'bg-sky-500/10 border-sky-500/20 group-hover:bg-sky-500/20' :
                                  project.status === 'SETTING_UP' ? 'bg-amber-500/10 border-amber-500/20 group-hover:bg-amber-500/20' :
                                  'bg-indigo-500/10 border-indigo-500/20 group-hover:bg-indigo-500/20'">
                      <app-icon [name]="statusIcon(project.status)" [size]="16"
                                [class]="project.status === 'READY' ? 'text-emerald-400' :
                                         project.status === 'INTERVIEWING' ? 'text-sky-400' :
                                         project.status === 'SETTING_UP' ? 'text-amber-400' :
                                         'text-indigo-400'" />
                    </div>
                    <div>
                      <p class="text-sm font-semibold text-white group-hover:text-indigo-300 transition-colors">{{ project.name }}</p>
                      <p class="text-[11px] text-slate-500 line-clamp-1 max-w-xs">{{ project.description || ('common.noDescription' | translate) }}</p>
                    </div>
                  </a>
                </td>
                <td class="px-4 py-3.5">
                  <span class="text-[10px] font-mono font-bold uppercase tracking-wider px-2.5 py-1 rounded-full inline-flex items-center gap-1" [class]="statusColor(project.status)">
                    <span class="h-1.5 w-1.5 rounded-full" [class]="project.status === 'READY' ? 'bg-emerald-400' :
                                                                      project.status === 'INTERVIEWING' ? 'bg-sky-400' :
                                                                      project.status === 'SETTING_UP' ? 'bg-amber-400' :
                                                                      'bg-slate-500'"></span>
                    {{ project.status }}
                  </span>
                </td>
                <td class="px-4 py-3.5 hidden md:table-cell">
                  <span class="font-mono text-xs text-slate-500 bg-white/[0.03] px-2 py-0.5 rounded">/{{ project.slug }}</span>
                </td>
                <td class="px-4 py-3.5 hidden lg:table-cell">
                  <span class="text-xs text-slate-500">{{ project.updatedAt | date:'dd.MM.yyyy HH:mm' }}</span>
                </td>
                <td class="px-4 py-3.5 text-right">
                  <a [routerLink]="['/projects', project.slug]" class="p-1.5 rounded-lg text-slate-600 hover:text-indigo-400 hover:bg-indigo-500/10 transition-all inline-flex">
                    <app-icon name="arrow-up-right" [size]="16" />
                  </a>
                </td>
              </tr>
            } @empty {
              <tr>
                <td colspan="5" class="px-4 py-16 text-center">
                  <div class="p-4 bg-slate-800/50 rounded-2xl inline-block mb-4">
                    <app-icon name="inbox" [size]="32" class="text-slate-600" />
                  </div>
                  <p class="text-sm text-slate-500">{{ 'projectsList.noProjects' | translate }}</p>
                  <p class="text-xs text-slate-600 mt-1">Create your first project to get started</p>
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    </div>
  `,
})
export class ProjectsPage implements OnInit {
  readonly i18n = inject(TranslateService);
  private api = inject(ApiService);

  projects = signal<Project[]>([]);
  searchQuery = '';
  filterStatus = '';
  sortField: 'updatedAt' | 'name' | 'createdAt' = 'updatedAt';

  filtered = computed(() => {
    let list = this.projects();

    if (this.searchQuery) {
      const q = this.searchQuery.toLowerCase();
      list = list.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.slug.toLowerCase().includes(q) ||
          (p.description ?? '').toLowerCase().includes(q),
      );
    }

    if (this.filterStatus) {
      list = list.filter((p) => p.status === this.filterStatus);
    }

    // Sort
    return [...list].sort((a, b) => {
      if (this.sortField === 'name') return a.name.localeCompare(b.name);
      const dateA = new Date(a[this.sortField]).getTime();
      const dateB = new Date(b[this.sortField]).getTime();
      return dateB - dateA;
    });
  });

  ngOnInit() {
    this.api.getProjects().subscribe((p) => this.projects.set(p));
  }

  countByStatus(status: string): number {
    return this.projects().filter((p) => p.status === status).length;
  }

  statusColor(status?: string): string {
    return STATUS_COLORS[status ?? ''] ?? 'text-slate-400 bg-slate-400/10';
  }

  statusIcon(status?: string): string {
    return STATUS_ICONS[status ?? ''] ?? 'circle';
  }
}
