import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./pages/dashboard/dashboard.page').then((m) => m.DashboardPage),
  },
  {
    path: 'projects/:slug',
    loadComponent: () =>
      import('./pages/project/project.page').then((m) => m.ProjectPage),
  },
  {
    path: 'projects',
    loadComponent: () =>
      import('./pages/projects/projects.page').then((m) => m.ProjectsPage),
  },
  {
    path: 'agents',
    loadComponent: () =>
      import('./pages/agents/agents.page').then((m) => m.AgentsPage),
  },
  {
    path: 'live-feed',
    loadComponent: () =>
      import('./pages/live-feed/live-feed.page').then((m) => m.LiveFeedPage),
  },
  {
    path: 'settings',
    loadComponent: () =>
      import('./pages/settings/settings.page').then((m) => m.SettingsPage),
  },
];
