import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, SystemSetting } from '../../services/api.service';
import { AuthInfoService } from '../../services/auth-info.service';
import { IconComponent } from '../../components/icon.component';

type Tab = 'user' | 'system';

interface SystemField {
  key: string;
  label: string;
  category: string;
  encrypted: boolean;
  description: string;
  type: 'text' | 'secret' | 'textarea' | 'select';
  options?: { value: string; label: string }[];
}

const AGENT_ROLES = [
  'TICKET_CREATOR',
  'CODER',
  'CODE_REVIEWER',
  'UI_TESTER',
  'PEN_TESTER',
  'DOCUMENTER',
] as const;

const AGENT_ROLE_LABELS: Record<string, string> = {
  TICKET_CREATOR: 'Ticket Creator',
  CODER: 'Coder',
  CODE_REVIEWER: 'Code Reviewer',
  UI_TESTER: 'UI Tester',
  PEN_TESTER: 'Pen Tester',
  DOCUMENTER: 'Documenter',
};

const LLM_PROVIDERS = [
  { value: 'OLLAMA', label: 'Ollama' },
  { value: 'ANTHROPIC', label: 'Anthropic' },
  { value: 'OPENAI', label: 'OpenAI' },
  { value: 'GOOGLE', label: 'Google AI' },
];

@Component({
  selector: 'app-settings',
  imports: [FormsModule, IconComponent],
  template: `
    <!-- Header -->
    <div class="mb-8">
      <h1
        class="text-3xl font-bold tracking-tight bg-gradient-to-r from-white to-slate-500 bg-clip-text text-transparent"
      >
        Settings
      </h1>
      <p class="text-slate-500 mt-1">
        Konfiguration und Einstellungen verwalten
      </p>
    </div>

    <!-- Tabs -->
    <div class="flex gap-2 mb-6">
      <button
        (click)="activeTab.set('user')"
        class="px-4 py-2 rounded-xl text-sm font-medium transition-all"
        [class]="
          activeTab() === 'user'
            ? 'bg-indigo-600 text-white'
            : 'text-slate-400 hover:text-white hover:bg-white/5'
        "
      >
        <app-icon name="user" [size]="16" class="inline mr-2" />
        Benutzer
      </button>
      @if (authInfo.isAdmin) {
        <button
          (click)="activeTab.set('system')"
          class="px-4 py-2 rounded-xl text-sm font-medium transition-all"
          [class]="
            activeTab() === 'system'
              ? 'bg-indigo-600 text-white'
              : 'text-slate-400 hover:text-white hover:bg-white/5'
          "
        >
          <app-icon name="shield" [size]="16" class="inline mr-2" />
          System
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
      <div class="glass rounded-3xl p-6">
        <h2 class="text-lg font-semibold text-white mb-6 flex items-center gap-2">
          <app-icon name="user" [size]="20" class="text-indigo-400" />
          Benutzer-Einstellungen
        </h2>

        <div class="space-y-6">
          <!-- Locale -->
          <div>
            <label class="block text-sm font-medium text-slate-400 mb-2"
              >Sprache</label
            >
            <select
              [(ngModel)]="userLocale"
              class="w-full bg-slate-900/50 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-indigo-500/50 transition-colors"
            >
              <option value="de">Deutsch</option>
              <option value="en">English</option>
            </select>
          </div>

          <!-- Theme -->
          <div>
            <label class="block text-sm font-medium text-slate-400 mb-2"
              >Theme</label
            >
            <select
              [(ngModel)]="userTheme"
              class="w-full bg-slate-900/50 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-indigo-500/50 transition-colors"
            >
              <option value="dark">Dark</option>
              <option value="light" disabled>Light (bald verfügbar)</option>
            </select>
          </div>

          <!-- Sidebar default -->
          <div class="flex items-center justify-between">
            <div>
              <label class="block text-sm font-medium text-slate-400"
                >Sidebar standardmäßig eingeklappt</label
              >
              <p class="text-xs text-slate-600 mt-0.5">
                Sidebar beim Start minimieren
              </p>
            </div>
            <button
              (click)="userSidebarCollapsed = !userSidebarCollapsed"
              class="relative w-12 h-6 rounded-full transition-colors"
              [class]="
                userSidebarCollapsed ? 'bg-indigo-600' : 'bg-slate-700'
              "
            >
              <div
                class="absolute top-0.5 w-5 h-5 bg-white rounded-full transition-transform"
                [class]="
                  userSidebarCollapsed ? 'translate-x-6' : 'translate-x-0.5'
                "
              ></div>
            </button>
          </div>
        </div>

        <div class="mt-8 flex justify-end">
          <button
            (click)="saveUserSettings()"
            [disabled]="saving()"
            class="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white px-6 py-3 rounded-full font-bold transition-all flex items-center gap-2"
          >
            <app-icon name="save" [size]="16" />
            {{ saving() ? 'Speichern...' : 'Speichern' }}
          </button>
        </div>
      </div>
    }

    <!-- System Settings Tab (Admin only) -->
    @if (activeTab() === 'system' && authInfo.isAdmin) {
      <div class="space-y-6">
        <!-- GitLab -->
        <div class="glass rounded-3xl p-6">
          <h2
            class="text-lg font-semibold text-white mb-6 flex items-center gap-2"
          >
            <app-icon name="git-branch" [size]="20" class="text-orange-400" />
            GitLab
          </h2>
          <div class="space-y-4">
            <div>
              <label class="block text-sm font-medium text-slate-400 mb-2"
                >URL</label
              >
              <input
                type="text"
                [(ngModel)]="sysValues['gitlab.url']"
                class="w-full bg-slate-900/50 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-indigo-500/50 transition-colors"
                placeholder="https://git.example.com"
              />
            </div>
            <div>
              <label class="block text-sm font-medium text-slate-400 mb-2"
                >API Token</label
              >
              <div class="relative">
                <input
                  [type]="showSecrets['gitlab.api_token'] ? 'text' : 'password'"
                  [(ngModel)]="sysValues['gitlab.api_token']"
                  class="w-full bg-slate-900/50 border border-white/10 rounded-xl px-4 py-3 pr-12 text-white font-mono focus:outline-none focus:border-indigo-500/50 transition-colors"
                  placeholder="glpat-****"
                />
                <button
                  (click)="
                    showSecrets['gitlab.api_token'] =
                      !showSecrets['gitlab.api_token']
                  "
                  class="absolute right-3 top-3 text-slate-500 hover:text-white transition-colors"
                >
                  <app-icon
                    [name]="
                      showSecrets['gitlab.api_token'] ? 'eye-off' : 'eye'
                    "
                    [size]="18"
                  />
                </button>
              </div>
            </div>
            <div>
              <label class="block text-sm font-medium text-slate-400 mb-2"
                >Webhook Secret</label
              >
              <div class="relative">
                <input
                  [type]="
                    showSecrets['gitlab.webhook_secret'] ? 'text' : 'password'
                  "
                  [(ngModel)]="sysValues['gitlab.webhook_secret']"
                  class="w-full bg-slate-900/50 border border-white/10 rounded-xl px-4 py-3 pr-12 text-white font-mono focus:outline-none focus:border-indigo-500/50 transition-colors"
                  placeholder="****"
                />
                <button
                  (click)="
                    showSecrets['gitlab.webhook_secret'] =
                      !showSecrets['gitlab.webhook_secret']
                  "
                  class="absolute right-3 top-3 text-slate-500 hover:text-white transition-colors"
                >
                  <app-icon
                    [name]="
                      showSecrets['gitlab.webhook_secret'] ? 'eye-off' : 'eye'
                    "
                    [size]="18"
                  />
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- LLM Providers -->
        <div class="glass rounded-3xl p-6">
          <h2
            class="text-lg font-semibold text-white mb-6 flex items-center gap-2"
          >
            <app-icon name="brain" [size]="20" class="text-violet-400" />
            LLM Provider
          </h2>
          <div class="space-y-4">
            <div>
              <label class="block text-sm font-medium text-slate-400 mb-2"
                >Ollama URL</label
              >
              <input
                type="text"
                [(ngModel)]="sysValues['llm.ollama.url']"
                class="w-full bg-slate-900/50 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-indigo-500/50 transition-colors"
                placeholder="http://127.0.0.1:11434"
              />
            </div>
            @for (
              provider of [
                {
                  key: 'llm.anthropic.api_key',
                  label: 'Anthropic API Key'
                },
                { key: 'llm.openai.api_key', label: 'OpenAI API Key' },
                { key: 'llm.google.api_key', label: 'Google AI API Key' }
              ];
              track provider.key
            ) {
              <div>
                <label class="block text-sm font-medium text-slate-400 mb-2">{{
                  provider.label
                }}</label>
                <div class="relative">
                  <input
                    [type]="showSecrets[provider.key] ? 'text' : 'password'"
                    [(ngModel)]="sysValues[provider.key]"
                    class="w-full bg-slate-900/50 border border-white/10 rounded-xl px-4 py-3 pr-12 text-white font-mono focus:outline-none focus:border-indigo-500/50 transition-colors"
                    placeholder="sk-****"
                  />
                  <button
                    (click)="
                      showSecrets[provider.key] = !showSecrets[provider.key]
                    "
                    class="absolute right-3 top-3 text-slate-500 hover:text-white transition-colors"
                  >
                    <app-icon
                      [name]="showSecrets[provider.key] ? 'eye-off' : 'eye'"
                      [size]="18"
                    />
                  </button>
                </div>
              </div>
            }
          </div>
        </div>

        <!-- Agent Defaults -->
        <div class="glass rounded-3xl p-6">
          <h2
            class="text-lg font-semibold text-white mb-6 flex items-center gap-2"
          >
            <app-icon name="bot" [size]="20" class="text-cyan-400" />
            Agent Defaults
          </h2>
          <div class="space-y-4">
            @for (role of agentRoles; track role) {
              <div
                class="grid grid-cols-3 gap-4 items-center"
              >
                <label class="text-sm font-medium text-slate-400">{{
                  agentRoleLabels[role]
                }}</label>
                <select
                  [(ngModel)]="agentDefaults[role].provider"
                  class="bg-slate-900/50 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-indigo-500/50 transition-colors"
                >
                  @for (p of llmProviders; track p.value) {
                    <option [value]="p.value">{{ p.label }}</option>
                  }
                </select>
                <input
                  type="text"
                  [(ngModel)]="agentDefaults[role].model"
                  class="bg-slate-900/50 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-indigo-500/50 transition-colors"
                  placeholder="Model name"
                />
              </div>
            }
          </div>
        </div>

        <!-- CORS / Security -->
        <div class="glass rounded-3xl p-6">
          <h2
            class="text-lg font-semibold text-white mb-6 flex items-center gap-2"
          >
            <app-icon name="shield" [size]="20" class="text-amber-400" />
            CORS / Sicherheit
          </h2>
          <div>
            <label class="block text-sm font-medium text-slate-400 mb-2"
              >Erlaubte Origins (eine pro Zeile)</label
            >
            <textarea
              [(ngModel)]="corsOriginsText"
              rows="4"
              class="w-full bg-slate-900/50 border border-white/10 rounded-xl px-4 py-3 text-white font-mono text-sm focus:outline-none focus:border-indigo-500/50 transition-colors resize-none"
              placeholder="https://hub.example.com"
            ></textarea>
            <p class="text-xs text-slate-600 mt-1">
              CORS-Änderungen erfordern einen API-Neustart
            </p>
          </div>
        </div>

        <!-- App -->
        <div class="glass rounded-3xl p-6">
          <h2
            class="text-lg font-semibold text-white mb-6 flex items-center gap-2"
          >
            <app-icon name="layout-dashboard" [size]="20" class="text-indigo-400" />
            Anwendung
          </h2>
          <div>
            <label class="block text-sm font-medium text-slate-400 mb-2"
              >App Name</label
            >
            <input
              type="text"
              [(ngModel)]="sysValues['app.name']"
              class="w-full bg-slate-900/50 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-indigo-500/50 transition-colors"
              placeholder="VibCode Hub"
            />
          </div>
        </div>

        <!-- Save Button -->
        <div class="flex justify-end">
          <button
            (click)="saveSystemSettings()"
            [disabled]="saving()"
            class="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white px-6 py-3 rounded-full font-bold transition-all flex items-center gap-2"
          >
            <app-icon name="save" [size]="16" />
            {{ saving() ? 'Speichern...' : 'System-Settings speichern' }}
          </button>
        </div>
      </div>
    }
  `,
})
export class SettingsPage implements OnInit {
  private api = inject(ApiService);
  authInfo = inject(AuthInfoService);

  activeTab = signal<Tab>('user');
  saving = signal(false);
  toast = signal<{ type: 'success' | 'error'; message: string } | null>(null);

  // User settings
  userLocale = 'de';
  userTheme = 'dark';
  userSidebarCollapsed = false;

  // System settings
  sysValues: Record<string, string> = {};
  showSecrets: Record<string, boolean> = {};
  corsOriginsText = '';
  agentRoles = [...AGENT_ROLES];
  agentRoleLabels = AGENT_ROLE_LABELS;
  llmProviders = LLM_PROVIDERS;
  agentDefaults: Record<string, { provider: string; model: string }> = {};

  // Track which encrypted fields have their original masked values
  private originalMaskedValues: Record<string, string> = {};

  ngOnInit() {
    this.loadUserSettings();
    if (this.authInfo.isAdmin) {
      this.loadSystemSettings();
    }

    // Initialize agent defaults
    for (const role of AGENT_ROLES) {
      this.agentDefaults[role] = { provider: 'OLLAMA', model: 'llama3.1' };
    }
  }

  private loadUserSettings() {
    this.api.getUserSettings().subscribe({
      next: (settings) => {
        this.userLocale = (settings['locale'] as string) ?? 'de';
        this.userTheme = (settings['theme'] as string) ?? 'dark';
        this.userSidebarCollapsed =
          (settings['sidebar.collapsed'] as boolean) ?? false;
      },
    });
  }

  private loadSystemSettings() {
    this.api.getSystemSettings().subscribe({
      next: (settings) => {
        for (const s of settings) {
          this.sysValues[s.key] = s.value;
          if (s.encrypted) {
            this.originalMaskedValues[s.key] = s.value;
          }
        }

        // Parse CORS origins
        try {
          const origins = JSON.parse(this.sysValues['cors.origins'] ?? '[]');
          this.corsOriginsText = origins.join('\n');
        } catch {
          this.corsOriginsText = this.sysValues['cors.origins'] ?? '';
        }

        // Parse agent defaults
        for (const role of AGENT_ROLES) {
          const key = `agents.defaults.${role}`;
          const raw = this.sysValues[key];
          if (raw) {
            try {
              this.agentDefaults[role] = JSON.parse(raw);
            } catch {
              /* keep default */
            }
          }
        }

        // Parse app name
        try {
          const name = JSON.parse(this.sysValues['app.name'] ?? '""');
          this.sysValues['app.name'] = name;
        } catch {
          /* keep as-is */
        }
      },
    });
  }

  saveUserSettings() {
    this.saving.set(true);
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
          this.showToast('success', 'Benutzer-Einstellungen gespeichert');
        },
        error: () => {
          this.saving.set(false);
          this.showToast('error', 'Fehler beim Speichern');
        },
      });
  }

  saveSystemSettings() {
    this.saving.set(true);

    const settings: {
      key: string;
      value: string;
      category?: string;
      encrypted?: boolean;
      description?: string;
    }[] = [];

    // GitLab
    settings.push({
      key: 'gitlab.url',
      value: this.sysValues['gitlab.url'] ?? '',
      category: 'gitlab',
    });
    this.pushSecretSetting(settings, 'gitlab.api_token', 'gitlab');
    this.pushSecretSetting(settings, 'gitlab.webhook_secret', 'gitlab');

    // LLM
    settings.push({
      key: 'llm.ollama.url',
      value: this.sysValues['llm.ollama.url'] ?? '',
      category: 'llm',
    });
    this.pushSecretSetting(settings, 'llm.anthropic.api_key', 'llm');
    this.pushSecretSetting(settings, 'llm.openai.api_key', 'llm');
    this.pushSecretSetting(settings, 'llm.google.api_key', 'llm');

    // CORS
    const origins = this.corsOriginsText
      .split('\n')
      .map((o) => o.trim())
      .filter((o) => o.length > 0);
    settings.push({
      key: 'cors.origins',
      value: JSON.stringify(origins),
      category: 'cors',
    });

    // App
    settings.push({
      key: 'app.name',
      value: JSON.stringify(this.sysValues['app.name'] ?? 'VibCode Hub'),
      category: 'app',
    });

    // Agent defaults
    for (const role of AGENT_ROLES) {
      settings.push({
        key: `agents.defaults.${role}`,
        value: JSON.stringify(this.agentDefaults[role]),
        category: 'agents',
      });
    }

    this.api.updateSystemSettings(settings).subscribe({
      next: (updated) => {
        // Refresh masked values
        for (const s of updated) {
          this.sysValues[s.key] = s.value;
          if (s.encrypted) {
            this.originalMaskedValues[s.key] = s.value;
          }
        }
        this.saving.set(false);
        this.showToast('success', 'System-Settings gespeichert');
      },
      error: () => {
        this.saving.set(false);
        this.showToast('error', 'Fehler beim Speichern');
      },
    });
  }

  /**
   * Only push encrypted settings if user actually changed the value
   * (i.e. it doesn't match the masked ****xxxx pattern)
   */
  private pushSecretSetting(
    settings: { key: string; value: string; category?: string; encrypted?: boolean }[],
    key: string,
    category: string,
  ) {
    const currentValue = this.sysValues[key] ?? '';
    const originalMasked = this.originalMaskedValues[key] ?? '';

    // Only send if user changed the value (not the masked placeholder)
    if (currentValue !== originalMasked) {
      settings.push({
        key,
        value: currentValue,
        category,
        encrypted: true,
      });
    }
  }

  private showToast(type: 'success' | 'error', message: string) {
    this.toast.set({ type, message });
    setTimeout(() => this.toast.set(null), 3000);
  }
}
