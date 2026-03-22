import { Component, inject, signal } from '@angular/core';
import { AuthInfoService } from '../../services/auth-info.service';
import { IconComponent } from '../../components/icon.component';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { UserSettingsComponent } from './user-settings.component';
import { SystemSettingsComponent } from './system-settings.component';
import { AgentRolesComponent } from './agent-roles.component';
import { TelegramSettingsComponent } from './telegram-settings.component';

type Tab = 'user' | 'system' | 'agents' | 'telegram';

@Component({
  selector: 'app-settings',
  imports: [IconComponent, TranslatePipe, UserSettingsComponent, SystemSettingsComponent, AgentRolesComponent, TelegramSettingsComponent],
  template: `
    <!-- Header -->
    <div class="mb-8 animate-in stagger-1">
      <h1
        class="text-3xl font-extrabold tracking-tight bg-gradient-to-r from-white via-indigo-200 to-slate-500 bg-clip-text text-transparent"
      >
        {{ 'settings.title' | translate }}
      </h1>
      <div class="mt-2 h-1 w-16 bg-gradient-to-r from-indigo-500 via-violet-500 to-purple-500 rounded-full"></div>
      <p class="text-slate-500 mt-2">
        {{ 'settings.subtitle' | translate }}
      </p>
    </div>

    <!-- Tabs -->
    <div class="flex gap-1 p-1 glass rounded-2xl mb-6 animate-in stagger-2 w-fit">
      <button
        (click)="activeTab.set('user')"
        class="px-5 py-2.5 rounded-xl text-sm font-medium transition-all flex items-center gap-2"
        [class]="
          activeTab() === 'user'
            ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/20'
            : 'text-slate-400 hover:text-white hover:bg-white/5'
        "
      >
        <app-icon name="user" [size]="16" />
        {{ 'settings.tabUser' | translate }}
      </button>
      @if (authInfo.isAdmin) {
        <button
          (click)="activeTab.set('system')"
          class="px-5 py-2.5 rounded-xl text-sm font-medium transition-all flex items-center gap-2"
          [class]="
            activeTab() === 'system'
              ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/20'
              : 'text-slate-400 hover:text-white hover:bg-white/5'
          "
        >
          <app-icon name="shield" [size]="16" />
          {{ 'settings.tabSystem' | translate }}
        </button>
        <button
          (click)="activeTab.set('agents')"
          class="px-5 py-2.5 rounded-xl text-sm font-medium transition-all flex items-center gap-2"
          [class]="
            activeTab() === 'agents'
              ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/20'
              : 'text-slate-400 hover:text-white hover:bg-white/5'
          "
        >
          <app-icon name="bot" [size]="16" />
          {{ 'settings.tabAgents' | translate }}
        </button>
        <button
          (click)="activeTab.set('telegram')"
          class="px-5 py-2.5 rounded-xl text-sm font-medium transition-all flex items-center gap-2"
          [class]="
            activeTab() === 'telegram'
              ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/20'
              : 'text-slate-400 hover:text-white hover:bg-white/5'
          "
        >
          <app-icon name="send" [size]="16" />
          {{ 'settings.telegramTab' | translate }}
        </button>
      }
    </div>

    <!-- Success/Error Toast -->
    @if (toast()) {
      <div
        class="mb-4 px-4 py-3 rounded-xl text-sm"
        [class]="
          toast()!.type === 'success'
            ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
            : 'bg-red-500/10 text-red-400 border border-red-500/20'
        "
      >
        {{ toast()!.message }}
      </div>
    }

    <!-- User Settings Tab -->
    @if (activeTab() === 'user') {
      <app-user-settings (saved)="showToast($event.type, $event.message)" />
    }

    <!-- System Settings Tab (Admin only) -->
    @if (activeTab() === 'system' && authInfo.isAdmin) {
      <app-system-settings (saved)="showToast($event.type, $event.message)" />
    }

    <!-- Agent Roles Tab (Admin only) -->
    @if (activeTab() === 'agents' && authInfo.isAdmin) {
      <app-agent-roles (saved)="showToast($event.type, $event.message)" />
    }

    <!-- Telegram Tab (Admin only) -->
    @if (activeTab() === 'telegram' && authInfo.isAdmin) {
      <app-telegram-settings (saved)="showToast($event.type, $event.message)" />
    }
  `,
})
export class SettingsPage {
  authInfo = inject(AuthInfoService);

  activeTab = signal<Tab>('user');
  toast = signal<{ type: 'success' | 'error'; message: string } | null>(null);

  showToast(type: 'success' | 'error', message: string) {
    this.toast.set({ type, message });
    setTimeout(() => this.toast.set(null), 3000);
  }
}
