import { Component, signal, inject, OnInit } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';
import { IconComponent } from './components/icon.component';
import { TranslatePipe } from './pipes/translate.pipe';
import { TranslateService, Locale } from './services/translate.service';
import { ApiService } from './services/api.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, IconComponent, TranslatePipe],
  template: `
    <!-- Sidebar -->
    <aside
      class="sticky top-0 h-screen glass-heavy z-50 flex flex-col shrink-0 transition-all duration-300"
      [class.w-56]="sidebarOpen()"
      [class.w-16]="!sidebarOpen()"
    >
      <!-- Logo -->
      <div class="flex items-center gap-3 px-4 h-14 border-b border-white/5">
        <button
          (click)="sidebarOpen.set(!sidebarOpen())"
          class="p-1.5 rounded-lg hover:bg-white/5 transition-colors text-slate-400 hover:text-white"
        >
          <app-icon [name]="sidebarOpen() ? 'panel-left-close' : 'panel-left-open'" [size]="18" />
        </button>
        @if (sidebarOpen()) {
          <a routerLink="/" class="text-base font-extrabold tracking-tight">
            <span class="bg-gradient-to-r from-indigo-400 via-violet-400 to-purple-400 bg-clip-text text-transparent">VibCode</span>
            <span class="text-slate-500 font-light ml-0.5">Hub</span>
          </a>
        }
      </div>

      <!-- Nav Links -->
      <nav class="flex-1 py-3 flex flex-col gap-0.5 px-2">
        <a
          routerLink="/"
          routerLinkActive="nav-link-active"
          [routerLinkActiveOptions]="{ exact: true }"
          class="flex items-center gap-3 px-3 py-2 rounded-xl text-slate-400 hover:text-white hover:bg-white/5 transition-all group"
        >
          <app-icon name="layout-dashboard" [size]="18" class="group-hover:scale-110 transition-transform" />
          @if (sidebarOpen()) {
            <span class="text-sm font-medium">{{ 'sidebar.dashboard' | translate }}</span>
          }
        </a>
        <a
          routerLink="/projects"
          routerLinkActive="nav-link-active"
          class="flex items-center gap-3 px-3 py-2 rounded-xl text-slate-400 hover:text-white hover:bg-white/5 transition-all group"
        >
          <app-icon name="folder-git-2" [size]="18" class="group-hover:scale-110 transition-transform" />
          @if (sidebarOpen()) {
            <span class="text-sm font-medium">{{ 'sidebar.projects' | translate }}</span>
          }
        </a>
        <a
          routerLink="/agents"
          routerLinkActive="nav-link-active"
          class="flex items-center gap-3 px-3 py-2 rounded-xl text-slate-400 hover:text-white hover:bg-white/5 transition-all group"
        >
          <app-icon name="bot" [size]="18" class="group-hover:scale-110 transition-transform" />
          @if (sidebarOpen()) {
            <span class="text-sm font-medium">{{ 'sidebar.agents' | translate }}</span>
          }
        </a>
        <a
          routerLink="/live-feed"
          routerLinkActive="nav-link-active"
          class="flex items-center gap-3 px-3 py-2 rounded-xl text-slate-400 hover:text-white hover:bg-white/5 transition-all group"
        >
          <app-icon name="activity" [size]="18" class="group-hover:scale-110 transition-transform" />
          @if (sidebarOpen()) {
            <span class="text-sm font-medium">{{ 'sidebar.liveFeed' | translate }}</span>
          }
        </a>
      </nav>

      <!-- Bottom -->
      <div class="px-2 py-3 border-t border-white/5">
        <a
          routerLink="/settings"
          routerLinkActive="nav-link-active"
          class="flex items-center gap-3 px-3 py-2 rounded-xl text-slate-400 hover:text-white hover:bg-white/5 transition-all cursor-pointer group"
        >
          <app-icon name="settings" [size]="18" class="group-hover:rotate-45 transition-transform duration-500" />
          @if (sidebarOpen()) {
            <span class="text-sm font-medium">{{ 'sidebar.settings' | translate }}</span>
          }
        </a>
      </div>
    </aside>

    <!-- Main Content -->
    <main class="flex-1 min-h-screen min-w-0">
      <div class="p-6 max-w-[1400px] mx-auto">
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
export class App implements OnInit {
  private i18n = inject(TranslateService);
  private api = inject(ApiService);
  sidebarOpen = signal(true);

  ngOnInit() {
    // Load user's preferred locale and theme from settings
    this.api.getUserSettings().subscribe((settings) => {
      const locale = settings['locale'] as Locale | undefined;
      if (locale) {
        this.i18n.use(locale);
      }

      const theme = settings['theme'] as string | undefined;
      if (theme) {
        document.documentElement.setAttribute('data-theme', theme);
      }
    });
  }
}
