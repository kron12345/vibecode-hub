import { Component, inject, OnInit, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../services/api.service';
import { IconComponent } from '../../components/icon.component';
import { TranslatePipe } from '../../pipes/translate.pipe';
import {
  TranslateService,
  SUPPORTED_LOCALES,
  Locale,
} from '../../services/translate.service';

@Component({
  selector: 'app-user-settings',
  standalone: true,
  imports: [FormsModule, IconComponent, TranslatePipe],
  template: `
    <div class="max-w-2xl animate-in stagger-3">
      <div class="glass rounded-2xl overflow-hidden">
        <div class="px-6 py-4 border-b border-white/5 flex items-center gap-2">
          <app-icon name="user" [size]="18" class="text-indigo-400" />
          <h2 class="text-base font-bold text-white">
            {{ 'settings.userSettings' | translate }}
          </h2>
        </div>

        <div class="p-6 space-y-5">
          <!-- Locale + Theme in grid -->
          <div class="grid grid-cols-2 gap-4">
            <div>
              <label class="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">
                {{ 'settings.locale' | translate }}
              </label>
              <select
                [(ngModel)]="userLocale"
                class="w-full bg-slate-900/50 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500/50 transition-colors"
              >
                @for (loc of supportedLocales; track loc) {
                  <option [value]="loc">{{ 'languages.' + loc | translate }}</option>
                }
              </select>
            </div>
            <div>
              <label class="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">
                {{ 'settings.theme' | translate }}
              </label>
              <select
                [(ngModel)]="userTheme"
                (ngModelChange)="applyTheme($event)"
                class="w-full bg-slate-900/50 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500/50 transition-colors"
              >
                <option value="dark">{{ 'settings.themeDark' | translate }}</option>
                <option value="light">{{ 'settings.themeLight' | translate }}</option>
              </select>
            </div>
          </div>

          <!-- Sidebar toggle -->
          <div class="flex items-center justify-between p-3 rounded-xl bg-white/[0.02] border border-white/5">
            <div>
              <label class="block text-sm font-medium text-slate-300">
                {{ 'settings.sidebarCollapsed' | translate }}
              </label>
              <p class="text-xs text-slate-600 mt-0.5">
                {{ 'settings.sidebarCollapsedHint' | translate }}
              </p>
            </div>
            <button
              (click)="userSidebarCollapsed = !userSidebarCollapsed"
              class="relative w-12 h-6 rounded-full transition-colors shrink-0 ml-4"
              [class]="
                userSidebarCollapsed ? 'bg-indigo-600' : 'bg-slate-700'
              "
            >
              <div
                class="absolute top-0.5 w-5 h-5 bg-white rounded-full transition-transform shadow-sm"
                [class]="
                  userSidebarCollapsed ? 'translate-x-6' : 'translate-x-0.5'
                "
              ></div>
            </button>
          </div>
        </div>

        <div class="px-6 py-4 border-t border-white/5 flex justify-end">
          <button
            (click)="saveUserSettings()"
            [disabled]="saving()"
            class="bg-indigo-600 hover:bg-indigo-500 hover:shadow-lg hover:shadow-indigo-500/25 disabled:opacity-50 text-white px-5 py-2.5 rounded-xl font-bold transition-all flex items-center gap-2 text-sm"
          >
            <app-icon name="save" [size]="16" />
            {{ (saving() ? 'common.saving' : 'common.save') | translate }}
          </button>
        </div>
      </div>
    </div>
  `,
})
export class UserSettingsComponent implements OnInit {
  private api = inject(ApiService);
  private i18n = inject(TranslateService);

  saved = output<{ type: 'success' | 'error'; message: string }>();

  saving = signal(false);

  userLocale: Locale = 'de';
  userTheme = 'dark';
  userSidebarCollapsed = false;
  supportedLocales = [...SUPPORTED_LOCALES];

  ngOnInit() {
    this.loadUserSettings();
  }

  private loadUserSettings() {
    this.api.getUserSettings().subscribe({
      next: (settings) => {
        this.userLocale = (settings['locale'] as Locale) ?? 'de';
        this.userTheme = (settings['theme'] as string) ?? 'dark';
        this.userSidebarCollapsed =
          (settings['sidebar.collapsed'] as boolean) ?? false;
      },
    });
  }

  applyTheme(theme: string) {
    document.documentElement.setAttribute('data-theme', theme);
  }

  saveUserSettings() {
    this.saving.set(true);
    this.i18n.use(this.userLocale);
    this.applyTheme(this.userTheme);

    this.api
      .updateUserSettings([
        { key: 'locale', value: JSON.stringify(this.userLocale) },
        { key: 'theme', value: JSON.stringify(this.userTheme) },
        {
          key: 'sidebar.collapsed',
          value: JSON.stringify(this.userSidebarCollapsed),
        },
      ])
      .subscribe({
        next: () => {
          this.saving.set(false);
          this.saved.emit({ type: 'success', message: this.i18n.t('settings.savedSuccess') });
        },
        error: () => {
          this.saving.set(false);
          this.saved.emit({ type: 'error', message: this.i18n.t('settings.savedError') });
        },
      });
  }
}
