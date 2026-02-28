import { Component, signal } from '@angular/core';
import { RouterOutlet, RouterLink } from '@angular/router';
import { IconComponent } from './components/icon.component';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, IconComponent],
  template: `
    <!-- Sidebar -->
    <aside
      class="fixed top-0 left-0 h-screen glass-heavy z-50 flex flex-col transition-all duration-300"
      [class]="sidebarOpen() ? 'w-56' : 'w-16'"
    >
      <!-- Logo -->
      <div class="flex items-center gap-3 px-4 h-16 border-b border-white/5">
        <button
          (click)="sidebarOpen.set(!sidebarOpen())"
          class="p-1 rounded-lg hover:bg-white/5 transition-colors text-slate-400 hover:text-white"
        >
          <app-icon [name]="sidebarOpen() ? 'panel-left-close' : 'panel-left-open'" [size]="20" />
        </button>
        @if (sidebarOpen()) {
          <a routerLink="/" class="text-lg font-bold tracking-tight">
            <span class="bg-gradient-to-r from-indigo-400 to-violet-400 bg-clip-text text-transparent">VibCode</span>
            <span class="text-slate-400 font-light"> Hub</span>
          </a>
        }
      </div>

      <!-- Nav Links -->
      <nav class="flex-1 py-4 flex flex-col gap-1 px-2">
        <a
          routerLink="/"
          class="flex items-center gap-3 px-3 py-2.5 rounded-xl text-slate-400 hover:text-white hover:bg-white/5 transition-all"
        >
          <app-icon name="layout-dashboard" [size]="18" />
          @if (sidebarOpen()) {
            <span class="text-sm font-medium">Dashboard</span>
          }
        </a>
        <a
          routerLink="/"
          class="flex items-center gap-3 px-3 py-2.5 rounded-xl text-slate-400 hover:text-white hover:bg-white/5 transition-all"
        >
          <app-icon name="folder-git-2" [size]="18" />
          @if (sidebarOpen()) {
            <span class="text-sm font-medium">Projekte</span>
          }
        </a>
        <a
          class="flex items-center gap-3 px-3 py-2.5 rounded-xl text-slate-400 hover:text-white hover:bg-white/5 transition-all cursor-pointer"
        >
          <app-icon name="bot" [size]="18" />
          @if (sidebarOpen()) {
            <span class="text-sm font-medium">Agenten</span>
          }
        </a>
        <a
          class="flex items-center gap-3 px-3 py-2.5 rounded-xl text-slate-400 hover:text-white hover:bg-white/5 transition-all cursor-pointer"
        >
          <app-icon name="activity" [size]="18" />
          @if (sidebarOpen()) {
            <span class="text-sm font-medium">Live Feed</span>
          }
        </a>
      </nav>

      <!-- Bottom -->
      <div class="px-2 py-4 border-t border-white/5">
        <a
          class="flex items-center gap-3 px-3 py-2.5 rounded-xl text-slate-400 hover:text-white hover:bg-white/5 transition-all cursor-pointer"
        >
          <app-icon name="settings" [size]="18" />
          @if (sidebarOpen()) {
            <span class="text-sm font-medium">Settings</span>
          }
        </a>
      </div>
    </aside>

    <!-- Main Content -->
    <main
      class="transition-all duration-300 min-h-screen"
      [class]="sidebarOpen() ? 'ml-56' : 'ml-16'"
    >
      <div class="p-6 max-w-7xl mx-auto">
        <router-outlet />
      </div>
    </main>
  `,
  styles: `
    :host {
      display: flex;
      min-height: 100vh;
    }
  `,
})
export class App {
  sidebarOpen = signal(true);
}
