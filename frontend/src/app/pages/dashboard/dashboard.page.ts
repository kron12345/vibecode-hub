import { Component, inject, OnInit, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiService, Project } from '../../services/api.service';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'app-dashboard',
  imports: [RouterLink, FormsModule],
  template: `
    <h1>Projekte</h1>

    <div class="project-grid">
      @for (project of projects(); track project.id) {
        <a [routerLink]="['/projects', project.slug]" class="project-card">
          <h3>{{ project.name }}</h3>
          <p>{{ project.description || 'Keine Beschreibung' }}</p>
          <span class="slug">/{{ project.slug }}</span>
        </a>
      }

      <button class="project-card add-card" (click)="showCreate = true">
        <span class="plus">+</span>
        <span>Neues Projekt</span>
      </button>
    </div>

    @if (showCreate) {
      <div class="modal-backdrop" (click)="showCreate = false">
        <div class="modal" (click)="$event.stopPropagation()">
          <h2>Neues Projekt</h2>
          <label>
            Name
            <input [(ngModel)]="newProject.name" (ngModelChange)="autoSlug()" />
          </label>
          <label>
            Slug
            <input [(ngModel)]="newProject.slug" />
          </label>
          <label>
            Beschreibung
            <textarea [(ngModel)]="newProject.description"></textarea>
          </label>
          <div class="actions">
            <button (click)="showCreate = false">Abbrechen</button>
            <button class="primary" (click)="createProject()">Erstellen</button>
          </div>
        </div>
      </div>
    }
  `,
  styles: `
    h1 { color: #eee; margin-bottom: 1.5rem; }
    .project-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 1rem;
    }
    .project-card {
      background: #16213e;
      border: 1px solid #1a1a2e;
      border-radius: 12px;
      padding: 1.5rem;
      text-decoration: none;
      color: #eee;
      transition: border-color 0.2s;
    }
    .project-card:hover { border-color: #e94560; }
    .project-card h3 { margin: 0 0 0.5rem; }
    .project-card p { color: #888; font-size: 0.875rem; }
    .slug { color: #e94560; font-size: 0.75rem; font-family: monospace; }
    .add-card {
      display: flex; flex-direction: column; align-items: center;
      justify-content: center; gap: 0.5rem; cursor: pointer;
      border: 2px dashed #333; background: transparent; color: #666;
    }
    .add-card:hover { border-color: #e94560; color: #e94560; }
    .plus { font-size: 2rem; }
    .modal-backdrop {
      position: fixed; inset: 0; background: rgba(0,0,0,0.7);
      display: flex; align-items: center; justify-content: center; z-index: 100;
    }
    .modal {
      background: #16213e; border-radius: 12px; padding: 2rem;
      min-width: 400px; color: #eee;
    }
    .modal label { display: block; margin-bottom: 1rem; }
    .modal input, .modal textarea {
      display: block; width: 100%; margin-top: 0.25rem;
      padding: 0.5rem; background: #0f3460; border: 1px solid #333;
      border-radius: 6px; color: #eee;
    }
    .modal textarea { min-height: 80px; resize: vertical; }
    .actions { display: flex; gap: 0.5rem; justify-content: flex-end; }
    .actions button {
      padding: 0.5rem 1rem; border-radius: 6px; border: 1px solid #333;
      background: #1a1a2e; color: #eee; cursor: pointer;
    }
    .actions .primary { background: #e94560; border-color: #e94560; }
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
}
