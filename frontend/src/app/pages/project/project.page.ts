import { Component, inject, OnInit, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { ApiService, Project } from '../../services/api.service';

@Component({
  selector: 'app-project',
  template: `
    @if (project(); as p) {
      <div class="project-header">
        <h1>{{ p.name }}</h1>
        <p class="description">{{ p.description }}</p>
      </div>

      <div class="project-layout">
        <section class="sidebar">
          <h3>Agenten</h3>
          <p class="placeholder">Noch keine Agenten konfiguriert</p>
        </section>

        <section class="main-area">
          <h3>Chat</h3>
          <div class="chat-placeholder">
            <p>Chat-Interface kommt in Phase 2</p>
          </div>
        </section>

        <section class="sidebar">
          <h3>Issues</h3>
          <p class="placeholder">Noch keine Issues vorhanden</p>
        </section>
      </div>
    } @else {
      <p>Projekt wird geladen...</p>
    }
  `,
  styles: `
    .project-header { margin-bottom: 2rem; }
    .project-header h1 { color: #eee; margin: 0; }
    .description { color: #888; }
    .project-layout {
      display: grid;
      grid-template-columns: 250px 1fr 300px;
      gap: 1rem;
      min-height: 60vh;
    }
    .sidebar {
      background: #16213e; border-radius: 12px; padding: 1rem;
    }
    .sidebar h3 { color: #e94560; margin-top: 0; }
    .main-area {
      background: #16213e; border-radius: 12px; padding: 1rem;
    }
    .main-area h3 { color: #e94560; margin-top: 0; }
    .placeholder { color: #666; font-size: 0.875rem; }
    .chat-placeholder {
      display: flex; align-items: center; justify-content: center;
      min-height: 400px; color: #666;
    }
  `,
})
export class ProjectPage implements OnInit {
  private route = inject(ActivatedRoute);
  private api = inject(ApiService);
  project = signal<Project | null>(null);

  ngOnInit() {
    const slug = this.route.snapshot.paramMap.get('slug');
    if (slug) {
      this.api.getProject(slug).subscribe((p) => this.project.set(p));
    }
  }
}
