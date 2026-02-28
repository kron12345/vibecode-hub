import { Component, inject, OnInit, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { ApiService, Project } from '../../services/api.service';
import { IconComponent } from '../../components/icon.component';

@Component({
  selector: 'app-dashboard',
  imports: [RouterLink, FormsModule, IconComponent],
  template: `
    <!-- Hardware Stats Bar -->
    <div class="flex flex-wrap gap-4 mb-8">
      <div class="glass flex-1 min-w-[200px] p-4 rounded-2xl flex items-center justify-between">
        <div>
          <p class="text-slate-500 text-xs uppercase tracking-widest font-bold">GPU Temp</p>
          <p class="text-xl font-mono text-emerald-400">--°C</p>
        </div>
        <app-icon name="thermometer" [size]="20" class="text-slate-600" />
      </div>
      <div class="glass flex-1 min-w-[200px] p-4 rounded-2xl flex items-center justify-between">
        <div>
          <p class="text-slate-500 text-xs uppercase tracking-widest font-bold">VRAM Load</p>
          <p class="text-xl font-mono text-indigo-400">-- / 48 GB</p>
        </div>
        <app-icon name="cpu" [size]="20" class="text-slate-600" />
      </div>
      <div class="glass flex-1 min-w-[200px] p-4 rounded-2xl flex items-center justify-between">
        <div>
          <p class="text-slate-500 text-xs uppercase tracking-widest font-bold">GitLab</p>
          <p class="text-xl font-mono text-white">Online</p>
        </div>
        <app-icon name="git-branch" [size]="20" class="text-orange-500" />
      </div>
      <div class="glass flex-1 min-w-[200px] p-4 rounded-2xl flex items-center justify-between">
        <div>
          <p class="text-slate-500 text-xs uppercase tracking-widest font-bold">Active Agents</p>
          <p class="text-xl font-mono text-violet-400">0 / 6</p>
        </div>
        <app-icon name="bot" [size]="20" class="text-slate-600" />
      </div>
    </div>

    <!-- Header -->
    <div class="flex items-center justify-between mb-8">
      <div>
        <h1 class="text-3xl font-bold tracking-tight bg-gradient-to-r from-white to-slate-500 bg-clip-text text-transparent">
          Projekte
        </h1>
        <p class="text-slate-500 mt-1">{{ projects().length }} Projekte im Hub</p>
      </div>
      <button
        (click)="showCreate = true"
        class="bg-indigo-600 hover:bg-indigo-500 text-white px-6 py-3 rounded-full font-bold transition-all flex items-center gap-2"
      >
        <app-icon name="plus" [size]="18" />
        Neues Projekt
      </button>
    </div>

    <!-- Project Bento Grid -->
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      @for (project of projects(); track project.id) {
        <a
          [routerLink]="['/projects', project.slug]"
          class="glass rounded-3xl p-6 group hover:border-indigo-500/30 transition-all duration-300 hover:-translate-y-1 hover:shadow-lg hover:shadow-indigo-500/10 block"
        >
          <div class="flex items-start justify-between mb-4">
            <div class="p-3 bg-indigo-500/20 text-indigo-400 rounded-2xl">
              <app-icon name="folder-git-2" [size]="22" />
            </div>
            <app-icon
              name="arrow-up-right"
              [size]="16"
              class="text-slate-600 group-hover:text-indigo-400 transition-colors"
            />
          </div>
          <h3 class="text-lg font-semibold text-white mb-1">{{ project.name }}</h3>
          <p class="text-sm text-slate-500 mb-4 line-clamp-2">
            {{ project.description || 'Keine Beschreibung' }}
          </p>
          <div class="flex items-center justify-between">
            <span class="font-mono text-xs text-indigo-400/70">/{{ project.slug }}</span>
            <span class="text-[10px] text-slate-600 uppercase tracking-widest">
              {{ formatDate(project.updatedAt) }}
            </span>
          </div>
        </a>
      }

      @if (projects().length === 0) {
        <!-- Skeleton cards while loading -->
        @for (i of [1, 2, 3]; track i) {
          <div class="glass rounded-3xl p-6">
            <div class="skeleton h-12 w-12 rounded-2xl mb-4"></div>
            <div class="skeleton h-5 w-3/4 mb-2"></div>
            <div class="skeleton h-4 w-full mb-1"></div>
            <div class="skeleton h-4 w-2/3"></div>
          </div>
        }
      }
    </div>

    <!-- Create Modal -->
    @if (showCreate) {
      <div
        class="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-content-center z-[100] flex items-center justify-center"
        (click)="showCreate = false"
      >
        <div
          class="glass-heavy rounded-3xl p-8 w-full max-w-md shadow-2xl"
          (click)="$event.stopPropagation()"
        >
          <h2 class="text-xl font-bold text-white mb-6">Neues Projekt</h2>

          <div class="space-y-4">
            <div>
              <label class="text-xs text-slate-500 uppercase tracking-widest font-bold block mb-1.5">Name</label>
              <input
                [(ngModel)]="newProject.name"
                (ngModelChange)="autoSlug()"
                class="w-full bg-slate-900/50 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500 transition-colors"
                placeholder="Mein Projekt"
              />
            </div>
            <div>
              <label class="text-xs text-slate-500 uppercase tracking-widest font-bold block mb-1.5">Slug</label>
              <input
                [(ngModel)]="newProject.slug"
                class="w-full bg-slate-900/50 border border-white/10 rounded-xl px-4 py-3 text-white font-mono text-sm placeholder-slate-600 focus:outline-none focus:border-indigo-500 transition-colors"
                placeholder="mein-projekt"
              />
            </div>
            <div>
              <label class="text-xs text-slate-500 uppercase tracking-widest font-bold block mb-1.5">Beschreibung</label>
              <textarea
                [(ngModel)]="newProject.description"
                rows="3"
                class="w-full bg-slate-900/50 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500 transition-colors resize-none"
                placeholder="Was wird gebaut?"
              ></textarea>
            </div>
          </div>

          <div class="flex gap-3 justify-end mt-6">
            <button
              (click)="showCreate = false"
              class="px-5 py-2.5 rounded-xl border border-white/10 text-slate-400 hover:text-white hover:border-white/20 transition-all"
            >
              Abbrechen
            </button>
            <button
              (click)="createProject()"
              class="px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold transition-all"
            >
              Erstellen
            </button>
          </div>
        </div>
      </div>
    }
  `,
})
export class DashboardPage implements OnInit {
  private api = inject(ApiService);
  projects = signal<Project[]>([]);
  showCreate = false;
  newProject = { name: '', slug: '', description: '' };

  ngOnInit() {
    this.loadProjects();
  }

  loadProjects() {
    this.api.getProjects().subscribe((p) => this.projects.set(p));
  }

  autoSlug() {
    this.newProject.slug = this.newProject.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  }

  createProject() {
    this.api.createProject(this.newProject).subscribe(() => {
      this.showCreate = false;
      this.newProject = { name: '', slug: '', description: '' };
      this.loadProjects();
    });
  }

  formatDate(dateStr: string): string {
    return new Date(dateStr).toLocaleDateString('de-DE', {
      day: '2-digit',
      month: 'short',
    });
  }
}
