import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  ApiService,
  SystemSetting,
  AgentRoleConfig,
  AgentPresetInfo,
  PipelineConfig,
  ProviderModel,
  ProviderModelsResult,
  CliToolStatus,
  McpServerDefinition,
} from '../../services/api.service';
import { AuthInfoService } from '../../services/auth-info.service';
import { IconComponent } from '../../components/icon.component';
import { TranslatePipe } from '../../pipes/translate.pipe';
import {
  TranslateService,
  SUPPORTED_LOCALES,
  Locale,
} from '../../services/translate.service';

type Tab = 'user' | 'system' | 'agents';

const AGENT_ROLES = [
  'INTERVIEWER',
  'ARCHITECT',
  'ISSUE_COMPILER',
  'CODER',
  'CODE_REVIEWER',
  'UI_TESTER',
  'FUNCTIONAL_TESTER',
  'PEN_TESTER',
  'DOCUMENTER',
  'DEVOPS',
] as const;

const AGENT_ROLE_LABEL_KEYS: Record<string, string> = {
  INTERVIEWER: 'agents.interviewer',
  ARCHITECT: 'agents.architect',
  ISSUE_COMPILER: 'agents.issueCompiler',
  CODER: 'agents.developer',
  CODE_REVIEWER: 'agents.reviewer',
  UI_TESTER: 'agents.uiTester',
  FUNCTIONAL_TESTER: 'agents.functionalTester',
  PEN_TESTER: 'agents.pentester',
  DOCUMENTER: 'agents.docs',
  DEVOPS: 'agents.devops',
};

const AGENT_ROLE_COLORS: Record<string, string> = {
  INTERVIEWER: 'sky',
  ARCHITECT: 'violet',
  ISSUE_COMPILER: 'amber',
  CODER: 'indigo',
  CODE_REVIEWER: 'emerald',
  UI_TESTER: 'pink',
  FUNCTIONAL_TESTER: 'teal',
  PEN_TESTER: 'red',
  DOCUMENTER: 'cyan',
  DEVOPS: 'orange',
};

const PROVIDER_TYPES = [
  { value: 'OLLAMA', label: 'Ollama (Local)', category: 'local' },
  { value: 'CLAUDE_CODE', label: 'Claude Code (CLI)', category: 'cli' },
  { value: 'CODEX_CLI', label: 'Codex CLI', category: 'cli' },
  { value: 'QWEN3_CODER', label: 'Qwen3 Coder (CLI)', category: 'cli' },
  { value: 'ANTHROPIC', label: 'Anthropic API', category: 'api' },
  { value: 'OPENAI', label: 'OpenAI API', category: 'api' },
  { value: 'GOOGLE', label: 'Google AI API', category: 'api' },
];

const PERMISSION_KEYS: { key: keyof AgentRoleConfig['permissions']; labelKey: string; icon: string }[] = [
  { key: 'fileRead', labelKey: 'settings.permFileRead', icon: 'file-search' },
  { key: 'fileWrite', labelKey: 'settings.permFileWrite', icon: 'file-edit' },
  { key: 'terminal', labelKey: 'settings.permTerminal', icon: 'terminal' },
  { key: 'installPackages', labelKey: 'settings.permInstall', icon: 'package' },
  { key: 'http', labelKey: 'settings.permHttp', icon: 'globe' },
  { key: 'gitOperations', labelKey: 'settings.permGit', icon: 'git-branch' },
];

@Component({
  selector: 'app-settings',
  imports: [FormsModule, IconComponent, TranslatePipe],
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
          (click)="activeTab.set('agents'); loadAgentData()"
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
                  class="w-full bg-slate-900/50 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500/50 transition-colors"
                >
                  <option value="dark">{{ 'settings.themeDark' | translate }}</option>
                  <option value="light" disabled>{{ 'settings.themeLight' | translate }}</option>
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
    }

    <!-- System Settings Tab (Admin only) -->
    @if (activeTab() === 'system' && authInfo.isAdmin) {
      <div class="space-y-4">
        <!-- GitLab -->
        <div class="glass rounded-2xl overflow-hidden animate-in stagger-3">
          <div class="px-6 py-3 border-b border-white/5 flex items-center gap-2">
            <app-icon name="git-branch" [size]="16" class="text-orange-400" />
            <h2 class="text-sm font-bold text-white uppercase tracking-wider">
              {{ 'settings.gitlab' | translate }}
            </h2>
          </div>
          <div class="p-6 space-y-4">
            <div>
              <label class="block text-sm font-medium text-slate-400 mb-2">
                {{ 'settings.gitlabUrl' | translate }}
              </label>
              <input
                type="text"
                [(ngModel)]="sysValues['gitlab.url']"
                class="w-full bg-slate-900/50 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-indigo-500/50 transition-colors"
                placeholder="https://git.example.com"
              />
            </div>
            <div>
              <label class="block text-sm font-medium text-slate-400 mb-2">
                {{ 'settings.gitlabToken' | translate }}
              </label>
              <div class="relative">
                <input
                  [type]="showSecrets['gitlab.api_token'] ? 'text' : 'password'"
                  [(ngModel)]="sysValues['gitlab.api_token']"
                  class="w-full bg-slate-900/50 border border-white/10 rounded-xl px-4 py-3 pr-12 text-white font-mono focus:outline-none focus:border-indigo-500/50 transition-colors"
                  placeholder="glpat-****"
                />
                <button
                  (click)="showSecrets['gitlab.api_token'] = !showSecrets['gitlab.api_token']"
                  class="absolute right-3 top-3 text-slate-500 hover:text-white transition-colors"
                >
                  <app-icon [name]="showSecrets['gitlab.api_token'] ? 'eye-off' : 'eye'" [size]="18" />
                </button>
              </div>
            </div>
            <div>
              <label class="block text-sm font-medium text-slate-400 mb-2">
                {{ 'settings.gitlabWebhook' | translate }}
              </label>
              <div class="relative">
                <input
                  [type]="showSecrets['gitlab.webhook_secret'] ? 'text' : 'password'"
                  [(ngModel)]="sysValues['gitlab.webhook_secret']"
                  class="w-full bg-slate-900/50 border border-white/10 rounded-xl px-4 py-3 pr-12 text-white font-mono focus:outline-none focus:border-indigo-500/50 transition-colors"
                  placeholder="****"
                />
                <button
                  (click)="showSecrets['gitlab.webhook_secret'] = !showSecrets['gitlab.webhook_secret']"
                  class="absolute right-3 top-3 text-slate-500 hover:text-white transition-colors"
                >
                  <app-icon [name]="showSecrets['gitlab.webhook_secret'] ? 'eye-off' : 'eye'" [size]="18" />
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- LLM Providers -->
        <div class="glass card-glow rounded-3xl p-6 animate-in stagger-4">
          <h2 class="text-lg font-semibold text-white mb-6 flex items-center gap-2">
            <app-icon name="brain" [size]="20" class="text-violet-400" />
            {{ 'settings.llmProviders' | translate }}
          </h2>
          <div class="space-y-4">
            <div>
              <label class="block text-sm font-medium text-slate-400 mb-2">
                {{ 'settings.ollamaUrl' | translate }}
              </label>
              <input
                type="text"
                [(ngModel)]="sysValues['llm.ollama.url']"
                class="w-full bg-slate-900/50 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-indigo-500/50 transition-colors"
                placeholder="http://127.0.0.1:11434"
              />
            </div>
            @for (
              provider of [
                { key: 'llm.anthropic.api_key', labelKey: 'settings.anthropicKey' },
                { key: 'llm.openai.api_key', labelKey: 'settings.openaiKey' },
                { key: 'llm.google.api_key', labelKey: 'settings.googleKey' }
              ];
              track provider.key
            ) {
              <div>
                <label class="block text-sm font-medium text-slate-400 mb-2">
                  {{ provider.labelKey | translate }}
                </label>
                <div class="relative">
                  <input
                    [type]="showSecrets[provider.key] ? 'text' : 'password'"
                    [(ngModel)]="sysValues[provider.key]"
                    class="w-full bg-slate-900/50 border border-white/10 rounded-xl px-4 py-3 pr-12 text-white font-mono focus:outline-none focus:border-indigo-500/50 transition-colors"
                    placeholder="sk-****"
                  />
                  <button
                    (click)="showSecrets[provider.key] = !showSecrets[provider.key]"
                    class="absolute right-3 top-3 text-slate-500 hover:text-white transition-colors"
                  >
                    <app-icon [name]="showSecrets[provider.key] ? 'eye-off' : 'eye'" [size]="18" />
                  </button>
                </div>
              </div>
            }
          </div>
        </div>

        <!-- Search / Web -->
        <div class="glass card-glow rounded-3xl p-6 animate-in stagger-5">
          <h2 class="text-lg font-semibold text-white mb-6 flex items-center gap-2">
            <app-icon name="search" [size]="20" class="text-cyan-400" />
            {{ 'settings.search' | translate }}
          </h2>
          <div class="space-y-4">
            <div>
              <label class="block text-sm font-medium text-slate-400 mb-1">
                {{ 'settings.searxngUrl' | translate }}
              </label>
              <p class="text-xs text-slate-500 mb-2">{{ 'settings.searxngUrlHint' | translate }}</p>
              <input
                type="text"
                [(ngModel)]="sysValues['search.searxng_url']"
                class="w-full bg-slate-900/50 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-indigo-500/50 transition-colors"
                placeholder="http://localhost:8088"
              />
            </div>
          </div>
        </div>

        <!-- CORS / Security -->
        <div class="glass card-glow rounded-3xl p-6 animate-in stagger-6">
          <h2 class="text-lg font-semibold text-white mb-6 flex items-center gap-2">
            <app-icon name="shield" [size]="20" class="text-amber-400" />
            {{ 'settings.cors' | translate }}
          </h2>
          <div>
            <label class="block text-sm font-medium text-slate-400 mb-2">
              {{ 'settings.corsOrigins' | translate }}
            </label>
            <textarea
              [(ngModel)]="corsOriginsText"
              rows="4"
              class="w-full bg-slate-900/50 border border-white/10 rounded-xl px-4 py-3 text-white font-mono text-sm focus:outline-none focus:border-indigo-500/50 transition-colors resize-none"
              placeholder="https://hub.example.com"
            ></textarea>
            <p class="text-xs text-slate-600 mt-1">
              {{ 'settings.corsHint' | translate }}
            </p>
          </div>
        </div>

        <!-- App -->
        <div class="glass card-glow rounded-3xl p-6 animate-in stagger-7">
          <h2 class="text-lg font-semibold text-white mb-6 flex items-center gap-2">
            <app-icon name="layout-dashboard" [size]="20" class="text-indigo-400" />
            {{ 'settings.app' | translate }}
          </h2>
          <div>
            <label class="block text-sm font-medium text-slate-400 mb-2">
              {{ 'settings.appName' | translate }}
            </label>
            <input
              type="text"
              [(ngModel)]="sysValues['app.name']"
              class="w-full bg-slate-900/50 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-indigo-500/50 transition-colors"
              placeholder="VibCode Hub"
            />
          </div>
        </div>

        <!-- Save Button -->
        <div class="flex justify-end animate-in stagger-8">
          <button
            (click)="saveSystemSettings()"
            [disabled]="saving()"
            class="bg-indigo-600 hover:bg-indigo-500 hover:shadow-lg hover:shadow-indigo-500/25 hover:scale-[1.02] disabled:opacity-50 text-white px-6 py-3 rounded-full font-bold transition-all flex items-center gap-2"
          >
            <app-icon name="save" [size]="16" />
            {{ (saving() ? 'common.saving' : 'settings.saveSystem') | translate }}
          </button>
        </div>
      </div>
    }

    <!-- Agent Roles Tab (Admin only) -->
    @if (activeTab() === 'agents' && authInfo.isAdmin) {
      <div class="space-y-6">

        <!-- Provider Status Bar -->
        <div class="glass card-glow rounded-3xl p-6 animate-in stagger-3">
          <h2 class="text-lg font-semibold text-white mb-4 flex items-center gap-2">
            <app-icon name="activity" [size]="20" class="text-emerald-400" />
            {{ 'settings.providerStatus' | translate }}
          </h2>
          <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
            <!-- Ollama Status -->
            <div class="bg-slate-900/50 border border-white/10 rounded-xl p-4">
              <div class="flex items-center justify-between mb-2">
                <span class="text-sm font-medium text-slate-300">Ollama</span>
                <div class="flex items-center gap-2">
                  @if (providerResults()['OLLAMA']?.available) {
                    <span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                    <span class="text-xs text-emerald-400">{{ providerResults()['OLLAMA'].models.length }} {{ 'settings.modelsShort' | translate }}</span>
                  } @else if (modelsLoading()) {
                    <span class="w-2 h-2 rounded-full bg-slate-500 animate-pulse"></span>
                    <span class="text-xs text-slate-500">...</span>
                  } @else {
                    <span class="w-2 h-2 rounded-full bg-red-400"></span>
                    <span class="text-xs text-red-400">{{ 'common.offline' | translate }}</span>
                  }
                </div>
              </div>
            </div>

            <!-- API Providers Status -->
            @for (p of apiProviderKeys; track p) {
              <div class="bg-slate-900/50 border border-white/10 rounded-xl p-4">
                <div class="flex items-center justify-between mb-2">
                  <span class="text-sm font-medium text-slate-300">{{ getProviderLabel(p) }}</span>
                  <div class="flex items-center gap-2">
                    @if (providerResults()[p]?.available) {
                      <span class="w-2 h-2 rounded-full bg-emerald-400"></span>
                      <span class="text-xs text-emerald-400">{{ providerResults()[p].models.length }} {{ 'settings.modelsShort' | translate }}</span>
                    } @else if (modelsLoading()) {
                      <span class="w-2 h-2 rounded-full bg-slate-500 animate-pulse"></span>
                      <span class="text-xs text-slate-500">...</span>
                    } @else if (providerResults()[p]?.error) {
                      <span class="w-2 h-2 rounded-full bg-amber-400"></span>
                      <span class="text-xs text-amber-400">{{ 'settings.noApiKey' | translate }}</span>
                    } @else {
                      <span class="w-2 h-2 rounded-full bg-slate-600"></span>
                      <span class="text-xs text-slate-600">—</span>
                    }
                  </div>
                </div>
              </div>
            }

            <!-- CLI Tools Status -->
            <div class="bg-slate-900/50 border border-white/10 rounded-xl p-4">
              <div class="flex items-center justify-between mb-2">
                <span class="text-sm font-medium text-slate-300">{{ 'settings.cliTools' | translate }}</span>
              </div>
              @for (tool of cliTools(); track tool.command) {
                <div class="flex items-center gap-2 mt-1">
                  @if (tool.installed) {
                    <span class="w-2 h-2 rounded-full bg-emerald-400"></span>
                  } @else {
                    <span class="w-2 h-2 rounded-full bg-slate-600"></span>
                  }
                  <span class="text-xs" [class]="tool.installed ? 'text-slate-300' : 'text-slate-600'">
                    {{ tool.name }}
                    @if (tool.version && tool.version !== 'unknown') {
                      <span class="text-slate-500">({{ tool.version }})</span>
                    }
                  </span>
                </div>
              }
            </div>
          </div>

          <!-- Refresh Button -->
          <button
            (click)="refreshAllProviders()"
            [disabled]="modelsLoading()"
            class="mt-4 text-xs text-indigo-400 hover:text-indigo-300 disabled:text-slate-600 transition-colors flex items-center gap-1"
          >
            <app-icon name="refresh-cw" [size]="12" [class]="modelsLoading() ? 'animate-spin' : ''" />
            {{ 'settings.refreshModels' | translate }}
          </button>
        </div>

        <!-- Pipeline Config -->
        <div class="glass card-glow rounded-3xl p-6 animate-in stagger-4">
          <h2 class="text-lg font-semibold text-white mb-4 flex items-center gap-2">
            <app-icon name="git-pull-request" [size]="20" class="text-violet-400" />
            {{ 'settings.pipelineConfig' | translate }}
          </h2>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div class="flex items-center justify-between">
              <div>
                <label class="block text-sm font-medium text-slate-400">
                  {{ 'settings.pipelineEnabled' | translate }}
                </label>
                <p class="text-xs text-slate-600 mt-0.5">
                  {{ 'settings.pipelineEnabledHint' | translate }}
                </p>
              </div>
              <button
                (click)="pipelineConfig.enabled = !pipelineConfig.enabled"
                class="relative w-12 h-6 rounded-full transition-colors"
                [class]="pipelineConfig.enabled ? 'bg-indigo-600' : 'bg-slate-700'"
              >
                <div
                  class="absolute top-0.5 w-5 h-5 bg-white rounded-full transition-transform"
                  [class]="pipelineConfig.enabled ? 'translate-x-6' : 'translate-x-0.5'"
                ></div>
              </button>
            </div>
            <div class="flex items-center justify-between">
              <div>
                <label class="block text-sm font-medium text-slate-400">
                  {{ 'settings.requireApproval' | translate }}
                </label>
                <p class="text-xs text-slate-600 mt-0.5">
                  {{ 'settings.requireApprovalHint' | translate }}
                </p>
              </div>
              <button
                (click)="pipelineConfig.requireApproval = !pipelineConfig.requireApproval"
                class="relative w-12 h-6 rounded-full transition-colors"
                [class]="pipelineConfig.requireApproval ? 'bg-indigo-600' : 'bg-slate-700'"
              >
                <div
                  class="absolute top-0.5 w-5 h-5 bg-white rounded-full transition-transform"
                  [class]="pipelineConfig.requireApproval ? 'translate-x-6' : 'translate-x-0.5'"
                ></div>
              </button>
            </div>
            <div>
              <label class="block text-sm font-medium text-slate-400 mb-2">
                {{ 'settings.maxConcurrent' | translate }}
              </label>
              <input
                type="number"
                [(ngModel)]="pipelineConfig.maxConcurrentAgents"
                min="1"
                max="10"
                class="w-full bg-slate-900/50 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-indigo-500/50 transition-colors"
              />
            </div>
            <div>
              <label class="block text-sm font-medium text-slate-400 mb-2">
                {{ 'settings.timeoutMinutes' | translate }}
              </label>
              <input
                type="number"
                [(ngModel)]="pipelineConfig.timeoutMinutes"
                min="5"
                max="120"
                class="w-full bg-slate-900/50 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-indigo-500/50 transition-colors"
              />
            </div>
            <div>
              <label class="block text-sm font-medium text-slate-400 mb-1">
                {{ 'settings.maxParallelOllama' | translate }}
              </label>
              <p class="text-xs text-slate-500 mb-2">{{ 'settings.maxParallelOllamaHint' | translate }}</p>
              <input
                type="number"
                [(ngModel)]="pipelineConfig.maxParallelOllamaModels"
                min="1"
                max="8"
                class="w-full bg-slate-900/50 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-indigo-500/50 transition-colors"
              />
            </div>
            <div>
              <label class="block text-sm font-medium text-slate-400 mb-1">
                {{ 'settings.maxFixAttempts' | translate }}
              </label>
              <p class="text-xs text-slate-500 mb-2">{{ 'settings.maxFixAttemptsHint' | translate }}</p>
              <input
                type="number"
                [(ngModel)]="pipelineConfig.maxFixAttempts"
                min="1"
                max="50"
                class="w-full bg-slate-900/50 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-indigo-500/50 transition-colors"
              />
            </div>
          </div>
        </div>

        <!-- MCP Servers -->
        <div class="glass card-glow rounded-3xl p-6 animate-in stagger-5">
          <h2 class="text-lg font-semibold text-white mb-2 flex items-center gap-2">
            <app-icon name="puzzle" [size]="20" class="text-cyan-400" />
            {{ 'settings.mcpServers' | translate }}
          </h2>
          <p class="text-sm text-slate-500 mb-5">
            {{ 'settings.mcpServersHint' | translate }}
          </p>

          @if (mcpServers().length === 0) {
            <p class="text-sm text-slate-600 italic">{{ 'settings.mcpNoServers' | translate }}</p>
          }

          <div class="space-y-3">
            @for (server of mcpServers(); track server.id) {
              <div class="rounded-2xl border border-white/5 bg-slate-900/30 overflow-hidden">
                <!-- Server Header -->
                <button
                  (click)="expandedMcpServers[server.id] = !expandedMcpServers[server.id]"
                  class="w-full px-5 py-3 flex items-center justify-between hover:bg-white/5 transition-colors"
                >
                  <div class="flex items-center gap-3">
                    <div class="w-8 h-8 rounded-lg flex items-center justify-center bg-cyan-500/20 text-cyan-400">
                      <app-icon name="puzzle" [size]="16" />
                    </div>
                    <div class="text-left">
                      <span class="text-white font-medium text-sm">{{ server.displayName }}</span>
                      @if (server.builtin) {
                        <span class="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-slate-700 text-slate-400 uppercase tracking-wider">
                          {{ 'settings.mcpServerBuiltin' | translate }}
                        </span>
                      }
                      <p class="text-xs text-slate-600">
                        {{ server.command }} {{ server.args.join(' ') }}
                        @if (server.argTemplate) {
                          <span class="text-cyan-600">{{ server.argTemplate }}</span>
                        }
                      </p>
                    </div>
                  </div>
                  <div class="flex items-center gap-3">
                    <button
                      (click)="toggleMcpServerEnabled(server, $event)"
                      class="relative w-10 h-5 rounded-full transition-colors"
                      [class]="server.enabled ? 'bg-emerald-600' : 'bg-slate-700'"
                    >
                      <div
                        class="absolute top-0.5 w-4 h-4 bg-white rounded-full transition-transform"
                        [class]="server.enabled ? 'translate-x-5' : 'translate-x-0.5'"
                      ></div>
                    </button>
                    <app-icon
                      [name]="expandedMcpServers[server.id] ? 'chevron-up' : 'chevron-down'"
                      [size]="16"
                      class="text-slate-500"
                    />
                  </div>
                </button>

                <!-- Expanded: Role Assignments -->
                @if (expandedMcpServers[server.id]) {
                  <div class="px-5 pb-4 border-t border-white/5 pt-3">
                    @if (server.description) {
                      <p class="text-xs text-slate-500 mb-3">{{ server.description }}</p>
                    }
                    <label class="block text-xs font-medium text-slate-400 mb-2">
                      {{ 'settings.mcpAssignedRoles' | translate }}
                    </label>
                    <div class="flex flex-wrap gap-2">
                      @for (role of agentRoles; track role) {
                        <button
                          (click)="toggleMcpServerRole(server, role)"
                          class="px-3 py-1.5 rounded-lg border text-xs font-medium transition-all"
                          [class]="
                            server.roles.includes(role)
                              ? 'border-cyan-500/30 bg-cyan-500/10 text-cyan-400'
                              : 'border-white/10 bg-slate-900/50 text-slate-500 hover:text-slate-300'
                          "
                        >
                          {{ agentRoleLabelKeys[role] | translate }}
                        </button>
                      }
                    </div>

                    @if (!server.builtin) {
                      <div class="mt-3 pt-3 border-t border-white/5 flex justify-end">
                        <button
                          (click)="deleteMcpServer(server)"
                          class="text-xs text-red-400 hover:text-red-300 transition-colors flex items-center gap-1"
                        >
                          <app-icon name="trash-2" [size]="12" />
                          {{ 'settings.mcpDeleteServer' | translate }}
                        </button>
                      </div>
                    }
                  </div>
                }
              </div>
            }
          </div>

          <!-- Add Custom Server -->
          @if (!showAddMcpServer) {
            <button
              (click)="showAddMcpServer = true"
              class="mt-4 flex items-center gap-2 text-sm text-cyan-400 hover:text-cyan-300 transition-colors"
            >
              <app-icon name="plus-circle" [size]="16" />
              {{ 'settings.mcpAddServer' | translate }}
            </button>
          } @else {
            <div class="mt-4 rounded-2xl border border-cyan-500/20 bg-slate-900/50 p-5 space-y-4">
              <h3 class="text-sm font-semibold text-white">{{ 'settings.mcpAddServer' | translate }}</h3>
              <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label class="block text-xs text-slate-400 mb-1">{{ 'settings.mcpServerName' | translate }}</label>
                  <input
                    type="text"
                    [(ngModel)]="newMcpServer.name"
                    placeholder="git"
                    class="w-full bg-slate-900/50 border border-white/10 rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:border-cyan-500/50"
                  />
                </div>
                <div>
                  <label class="block text-xs text-slate-400 mb-1">Display Name</label>
                  <input
                    type="text"
                    [(ngModel)]="newMcpServer.displayName"
                    placeholder="Git Server"
                    class="w-full bg-slate-900/50 border border-white/10 rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:border-cyan-500/50"
                  />
                </div>
                <div>
                  <label class="block text-xs text-slate-400 mb-1">{{ 'settings.mcpServerCommand' | translate }}</label>
                  <input
                    type="text"
                    [(ngModel)]="newMcpServer.command"
                    placeholder="npx"
                    class="w-full bg-slate-900/50 border border-white/10 rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:border-cyan-500/50"
                  />
                </div>
                <div>
                  <label class="block text-xs text-slate-400 mb-1">{{ 'settings.mcpServerArgs' | translate }}</label>
                  <input
                    type="text"
                    [(ngModel)]="newMcpServerArgsText"
                    placeholder="@modelcontextprotocol/server-git"
                    class="w-full bg-slate-900/50 border border-white/10 rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:border-cyan-500/50"
                  />
                </div>
              </div>
              <div>
                <label class="block text-xs text-slate-400 mb-1">
                  {{ 'settings.mcpServerArgTemplate' | translate }}
                  <span class="text-slate-600 ml-1">{{ 'settings.mcpServerArgTemplateHint' | translate }}</span>
                </label>
                <input
                  type="text"
                  [(ngModel)]="newMcpServer.argTemplate"
                  placeholder="{workspace}"
                  class="w-full bg-slate-900/50 border border-white/10 rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:border-cyan-500/50"
                />
              </div>
              <div class="flex gap-3 justify-end">
                <button
                  (click)="showAddMcpServer = false"
                  class="px-4 py-2 text-sm text-slate-400 hover:text-white transition-colors"
                >
                  {{ 'common.cancel' | translate }}
                </button>
                <button
                  (click)="addMcpServer()"
                  [disabled]="!newMcpServer.name || !newMcpServer.command"
                  class="px-4 py-2 text-sm bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white rounded-xl transition-colors"
                >
                  {{ 'common.save' | translate }}
                </button>
              </div>
            </div>
          }
        </div>

        <!-- Presets -->
        @if (availablePresets().length > 0) {
          <div class="glass card-glow rounded-3xl p-6 animate-in stagger-5">
            <h2 class="text-lg font-semibold text-white mb-4 flex items-center gap-2">
              <app-icon name="layout-template" [size]="20" class="text-amber-400" />
              {{ 'settings.presets' | translate }}
            </h2>
            <p class="text-sm text-slate-400 mb-4">
              {{ 'settings.presetsHint' | translate }}
            </p>
            <div class="flex flex-wrap gap-3">
              @for (preset of availablePresets(); track preset.id) {
                <button
                  (click)="applyPreset(preset.id)"
                  [disabled]="applyingPreset()"
                  class="flex items-center gap-3 px-5 py-3 rounded-2xl border border-white/10 bg-slate-900/50 hover:bg-white/5 hover:border-white/20 transition-all disabled:opacity-50"
                >
                  <app-icon [name]="preset.icon" [size]="18" class="text-amber-400" />
                  <div class="text-left">
                    <span class="text-sm font-medium text-white">{{ preset.name }}</span>
                    <p class="text-xs text-slate-500">{{ preset.description }}</p>
                  </div>
                </button>
              }
            </div>
          </div>
        }

        <!-- Agent Role Cards -->
        @for (role of agentRoles; track role; let i = $index) {
          <div class="glass card-glow rounded-3xl animate-in" [style.animation-delay]="(0.3 + i * 0.05) + 's'">
            <!-- Role Header (clickable to expand) -->
            <button
              (click)="toggleRoleExpanded(role)"
              class="w-full px-6 py-4 flex items-center justify-between hover:bg-white/5 transition-colors rounded-t-3xl"
            >
              <div class="flex items-center gap-3">
                <div
                  class="w-10 h-10 rounded-xl flex items-center justify-center"
                  [class]="getAgentColorClass(role)"
                >
                  <app-icon [name]="getRoleIcon(role)" [size]="20" />
                </div>
                <div class="text-left">
                  <h3 class="text-white font-semibold">
                    {{ agentRoleLabelKeys[role] | translate }}
                  </h3>
                  <p class="text-xs text-slate-500">
                    {{ getRoleDescription(role) }}
                    <span class="text-slate-600 ml-2">
                      #{{ getRolePipelinePosition(role) }} &middot;
                      {{ getRoleProvider(role) }} / {{ getRoleModel(role) }}
                    </span>
                  </p>
                </div>
              </div>
              <app-icon
                [name]="expandedRoles[role] ? 'chevron-up' : 'chevron-down'"
                [size]="20"
                class="text-slate-500"
              />
            </button>

            <!-- Expanded Content -->
            @if (expandedRoles[role]) {
              <div class="px-6 pb-6 border-t border-white/5 pt-4 space-y-6">
                <!-- Row 1: Provider + Model -->
                <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label class="block text-sm font-medium text-slate-400 mb-2">
                      {{ 'settings.provider' | translate }}
                    </label>
                    <div class="relative">
                      <select
                        [(ngModel)]="agentRoleConfigs[role].provider"
                        class="w-full appearance-none bg-slate-900/50 border border-white/10 rounded-xl pl-4 pr-10 py-3 text-white focus:outline-none focus:border-indigo-500/50 transition-colors cursor-pointer"
                      >
                        <optgroup label="Local">
                          @for (p of getProvidersByCategory('local'); track p.value) {
                            <option [value]="p.value">{{ p.label }}</option>
                          }
                        </optgroup>
                        <optgroup label="CLI">
                          @for (p of getProvidersByCategory('cli'); track p.value) {
                            <option [value]="p.value">{{ p.label }}</option>
                          }
                        </optgroup>
                        <optgroup label="API">
                          @for (p of getProvidersByCategory('api'); track p.value) {
                            <option [value]="p.value">{{ p.label }}</option>
                          }
                        </optgroup>
                      </select>
                      <app-icon name="chevron-down" [size]="16" class="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
                    </div>
                  </div>
                  <div>
                    <label class="block text-sm font-medium text-slate-400 mb-2">
                      {{ 'settings.model' | translate }}
                    </label>
                    @if (getModelsForProvider(agentRoleConfigs[role].provider).length > 0) {
                      <div class="relative">
                        <select
                          [(ngModel)]="agentRoleConfigs[role].model"
                          class="w-full appearance-none bg-slate-900/50 border border-indigo-500/30 rounded-xl pl-4 pr-10 py-3 text-white focus:outline-none focus:border-indigo-500/50 transition-colors cursor-pointer"
                        >
                          @if (agentRoleConfigs[role].model && !isModelInList(agentRoleConfigs[role].model, agentRoleConfigs[role].provider)) {
                            <option [value]="agentRoleConfigs[role].model">
                              {{ agentRoleConfigs[role].model }} ({{ 'settings.modelNotFound' | translate }})
                            </option>
                          }
                          @for (m of getModelsForProvider(agentRoleConfigs[role].provider); track m.name) {
                            <option [value]="m.name">
                              {{ m.displayName || m.name }}
                              @if (m.parameterSize) {
                                ({{ m.parameterSize }})
                              }
                            </option>
                          }
                        </select>
                        <app-icon name="chevron-down" [size]="16" class="absolute right-3 top-1/2 -translate-y-1/2 text-indigo-400 pointer-events-none" />
                      </div>
                      <p class="text-xs text-indigo-400/60 mt-1">
                        {{ getModelsForProvider(agentRoleConfigs[role].provider).length }}
                        {{ 'settings.modelsAvailable' | translate }}
                      </p>
                    } @else {
                      <input
                        type="text"
                        [(ngModel)]="agentRoleConfigs[role].model"
                        class="w-full bg-slate-900/50 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-indigo-500/50 transition-colors"
                        placeholder="llama3.1, claude-sonnet-4-6, gpt-4o, ..."
                      />
                      <p class="text-xs text-slate-600 mt-1">
                        {{ 'settings.modelManualHint' | translate }}
                      </p>
                    }
                  </div>
                </div>

                <!-- Row 2: Parameters -->
                <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <label class="block text-sm font-medium text-slate-400 mb-2">
                      {{ 'settings.temperature' | translate }}
                      <span class="text-indigo-400 ml-1">{{ agentRoleConfigs[role].parameters.temperature }}</span>
                    </label>
                    <input
                      type="range"
                      [(ngModel)]="agentRoleConfigs[role].parameters.temperature"
                      min="0"
                      max="1"
                      step="0.1"
                      class="w-full accent-indigo-500"
                    />
                    <div class="flex justify-between text-xs text-slate-600 mt-1">
                      <span>{{ 'settings.precise' | translate }}</span>
                      <span>{{ 'settings.creative' | translate }}</span>
                    </div>
                  </div>
                  <div>
                    <label class="block text-sm font-medium text-slate-400 mb-2">
                      {{ 'settings.maxTokens' | translate }}
                    </label>
                    <input
                      type="number"
                      [(ngModel)]="agentRoleConfigs[role].parameters.maxTokens"
                      min="256"
                      max="32768"
                      step="256"
                      class="w-full bg-slate-900/50 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-indigo-500/50 transition-colors"
                    />
                  </div>
                  <div>
                    <label class="block text-sm font-medium text-slate-400 mb-2">
                      {{ 'settings.pipelinePos' | translate }}
                    </label>
                    <input
                      type="number"
                      [(ngModel)]="agentRoleConfigs[role].pipelinePosition"
                      min="1"
                      max="20"
                      class="w-full bg-slate-900/50 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-indigo-500/50 transition-colors"
                    />
                  </div>
                </div>

                <!-- Row 3: Permissions -->
                <div>
                  <label class="block text-sm font-medium text-slate-400 mb-3">
                    {{ 'settings.permissions' | translate }}
                  </label>
                  <div class="grid grid-cols-2 md:grid-cols-3 gap-3">
                    @for (perm of permissionKeys; track perm.key) {
                      <button
                        (click)="togglePermission(role, perm.key)"
                        class="flex items-center gap-2 px-3 py-2 rounded-xl border transition-all text-sm"
                        [class]="
                          agentRoleConfigs[role].permissions[perm.key]
                            ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                            : 'border-white/10 bg-slate-900/50 text-slate-500 hover:text-slate-300'
                        "
                      >
                        <app-icon [name]="perm.icon" [size]="14" />
                        {{ perm.labelKey | translate }}
                      </button>
                    }
                  </div>
                </div>

                <!-- Row 4: System Prompt -->
                <div>
                  <label class="block text-sm font-medium text-slate-400 mb-2">
                    {{ 'settings.systemPrompt' | translate }}
                  </label>
                  <textarea
                    [(ngModel)]="agentRoleConfigs[role].systemPrompt"
                    rows="8"
                    class="w-full bg-slate-900/50 border border-white/10 rounded-xl px-4 py-3 text-white font-mono text-xs leading-relaxed focus:outline-none focus:border-indigo-500/50 transition-colors resize-y"
                    [placeholder]="'settings.systemPromptPlaceholder' | translate"
                  ></textarea>
                  <p class="text-xs text-slate-600 mt-1">
                    {{ 'settings.systemPromptHint' | translate }}
                  </p>
                </div>
              </div>
            }
          </div>
        }

        <!-- Save Button -->
        <div class="flex justify-end">
          <button
            (click)="saveAgentSettings()"
            [disabled]="saving()"
            class="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white px-6 py-3 rounded-full font-bold transition-all flex items-center gap-2"
          >
            <app-icon name="save" [size]="16" />
            {{ (saving() ? 'common.saving' : 'settings.saveAgents') | translate }}
          </button>
        </div>
      </div>
    }
  `,
})
export class SettingsPage implements OnInit {
  private api = inject(ApiService);
  private i18n = inject(TranslateService);
  authInfo = inject(AuthInfoService);

  activeTab = signal<Tab>('user');
  saving = signal(false);
  toast = signal<{ type: 'success' | 'error'; message: string } | null>(null);

  // User settings
  userLocale: Locale = 'de';
  userTheme = 'dark';
  userSidebarCollapsed = false;
  supportedLocales = [...SUPPORTED_LOCALES];

  // System settings
  sysValues: Record<string, string> = {};
  showSecrets: Record<string, boolean> = {};
  corsOriginsText = '';
  private originalMaskedValues: Record<string, string> = {};

  // Agent role settings
  agentRoles = [...AGENT_ROLES];
  agentRoleLabelKeys = AGENT_ROLE_LABEL_KEYS;
  providerTypes = PROVIDER_TYPES;
  permissionKeys = PERMISSION_KEYS;
  agentRoleConfigs: Record<string, AgentRoleConfig> = {};
  pipelineConfig: PipelineConfig = {
    enabled: false,
    autoStart: false,
    requireApproval: true,
    maxConcurrentAgents: 2,
    timeoutMinutes: 30,
    maxParallelOllamaModels: 1,
    maxFixAttempts: 5,
  };
  expandedRoles: Record<string, boolean> = {};
  availablePresets = signal<AgentPresetInfo[]>([]);
  applyingPreset = signal(false);

  // MCP Servers
  mcpServers = signal<McpServerDefinition[]>([]);
  expandedMcpServers: Record<string, boolean> = {};
  showAddMcpServer = false;
  newMcpServer: Partial<McpServerDefinition> = {};
  newMcpServerArgsText = '';

  // Provider discovery
  providerResults = signal<Record<string, ProviderModelsResult>>({});
  modelsLoading = signal(false);
  cliTools = signal<CliToolStatus[]>([]);
  apiProviderKeys = ['ANTHROPIC', 'OPENAI', 'GOOGLE'];

  ngOnInit() {
    this.loadUserSettings();
    if (this.authInfo.isAdmin) {
      this.loadSystemSettings();
    }

    // Initialize empty configs for all roles
    for (const role of AGENT_ROLES) {
      this.agentRoleConfigs[role] = {
        provider: 'OLLAMA',
        model: 'llama3.1',
        systemPrompt: '',
        parameters: { temperature: 0.3, maxTokens: 4096 },
        permissions: {
          fileRead: true,
          fileWrite: false,
          terminal: false,
          installPackages: false,
          http: false,
          gitOperations: false,
        },
        pipelinePosition: 0,
        description: '',
        color: 'slate',
        icon: 'bot',
      };
    }
  }

  loadAgentData() {
    if (Object.keys(this.agentRoleConfigs).length > 0 && this.agentRoleConfigs['INTERVIEWER']?.systemPrompt) {
      return; // Already loaded
    }

    this.api.getAgentRoleConfigs().subscribe({
      next: (configs) => {
        for (const [role, config] of Object.entries(configs)) {
          this.agentRoleConfigs[role] = { ...config };
        }
      },
    });

    this.api.getPipelineConfig().subscribe({
      next: (config) => {
        this.pipelineConfig = { ...config };
      },
    });

    this.api.getAgentPresets().subscribe({
      next: (presets) => this.availablePresets.set(presets),
    });

    this.loadMcpServers();
    this.refreshAllProviders();
  }

  refreshAllProviders() {
    this.modelsLoading.set(true);

    // Fetch all provider models in one call
    this.api.getProviderModels().subscribe({
      next: (results) => {
        console.log('[Settings] Provider models loaded:', Object.keys(results).map(k => `${k}: ${results[k]?.models?.length ?? 0} models`));
        this.providerResults.set(results);
        this.modelsLoading.set(false);
      },
      error: (err) => {
        console.error('[Settings] Failed to load provider models:', err?.status, err?.message || err);
        this.modelsLoading.set(false);
      },
    });

    // CLI tools are a separate endpoint (detects local binaries)
    this.api.getCliToolStatus().subscribe({
      next: (tools) => this.cliTools.set(tools),
    });
  }

  getModelsForProvider(provider: string): ProviderModel[] {
    return this.providerResults()[provider]?.models ?? [];
  }

  isModelInList(model: string, provider: string): boolean {
    return this.getModelsForProvider(provider).some((m) => m.name === model);
  }

  getProviderLabel(provider: string): string {
    const labels: Record<string, string> = {
      OLLAMA: 'Ollama',
      ANTHROPIC: 'Anthropic',
      OPENAI: 'OpenAI',
      GOOGLE: 'Google AI',
      CLAUDE_CODE: 'Claude Code',
      CODEX_CLI: 'Codex CLI',
      QWEN3_CODER: 'Qwen3 Coder',
    };
    return labels[provider] ?? provider;
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

  private loadSystemSettings() {
    this.api.getSystemSettings().subscribe({
      next: (settings) => {
        for (const s of settings) {
          this.sysValues[s.key] = s.value;
          if (s.encrypted) {
            this.originalMaskedValues[s.key] = s.value;
          }
        }

        try {
          const origins = JSON.parse(this.sysValues['cors.origins'] ?? '[]');
          this.corsOriginsText = origins.join('\n');
        } catch {
          this.corsOriginsText = this.sysValues['cors.origins'] ?? '';
        }

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
    this.i18n.use(this.userLocale);

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
          this.showToast('success', this.i18n.t('settings.savedSuccess'));
        },
        error: () => {
          this.saving.set(false);
          this.showToast('error', this.i18n.t('settings.savedError'));
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
    }[] = [];

    settings.push({
      key: 'gitlab.url',
      value: this.sysValues['gitlab.url'] ?? '',
      category: 'gitlab',
    });
    this.pushSecretSetting(settings, 'gitlab.api_token', 'gitlab');
    this.pushSecretSetting(settings, 'gitlab.webhook_secret', 'gitlab');

    settings.push({
      key: 'llm.ollama.url',
      value: this.sysValues['llm.ollama.url'] ?? '',
      category: 'llm',
    });
    this.pushSecretSetting(settings, 'llm.anthropic.api_key', 'llm');
    this.pushSecretSetting(settings, 'llm.openai.api_key', 'llm');
    this.pushSecretSetting(settings, 'llm.google.api_key', 'llm');

    settings.push({
      key: 'search.searxng_url',
      value: this.sysValues['search.searxng_url'] ?? '',
      category: 'search',
    });

    const origins = this.corsOriginsText
      .split('\n')
      .map((o) => o.trim())
      .filter((o) => o.length > 0);
    settings.push({
      key: 'cors.origins',
      value: JSON.stringify(origins),
      category: 'cors',
    });

    settings.push({
      key: 'app.name',
      value: JSON.stringify(this.sysValues['app.name'] ?? 'VibCode Hub'),
      category: 'app',
    });

    this.api.updateSystemSettings(settings).subscribe({
      next: (updated) => {
        for (const s of updated) {
          this.sysValues[s.key] = s.value;
          if (s.encrypted) {
            this.originalMaskedValues[s.key] = s.value;
          }
        }
        this.saving.set(false);
        this.showToast('success', this.i18n.t('settings.systemSaved'));
      },
      error: () => {
        this.saving.set(false);
        this.showToast('error', this.i18n.t('settings.savedError'));
      },
    });
  }

  saveAgentSettings() {
    this.saving.set(true);

    const settings: {
      key: string;
      value: string;
      category?: string;
    }[] = [];

    // Save each role config
    for (const role of AGENT_ROLES) {
      settings.push({
        key: `agents.roles.${role}`,
        value: JSON.stringify(this.agentRoleConfigs[role]),
        category: 'agents',
      });
    }

    // Save pipeline config
    settings.push({
      key: 'agents.pipeline',
      value: JSON.stringify(this.pipelineConfig),
      category: 'agents',
    });

    this.api.updateSystemSettings(settings).subscribe({
      next: () => {
        this.saving.set(false);
        this.showToast('success', this.i18n.t('settings.agentsSaved'));
      },
      error: () => {
        this.saving.set(false);
        this.showToast('error', this.i18n.t('settings.savedError'));
      },
    });
  }

  applyPreset(presetId: string) {
    this.applyingPreset.set(true);
    this.api.applyAgentPreset(presetId).subscribe({
      next: (result) => {
        // Reload configs to reflect the preset changes
        this.api.getAgentRoleConfigs().subscribe({
          next: (configs) => {
            for (const [role, config] of Object.entries(configs)) {
              this.agentRoleConfigs[role] = { ...config };
            }
            this.applyingPreset.set(false);
            this.showToast('success', this.i18n.t('settings.presetApplied', { name: result.name }));
          },
        });
      },
      error: () => {
        this.applyingPreset.set(false);
        this.showToast('error', this.i18n.t('settings.savedError'));
      },
    });
  }

  // ─── Agent Role Helpers ─────────────────────────────────────

  toggleRoleExpanded(role: string) {
    this.expandedRoles[role] = !this.expandedRoles[role];
  }

  togglePermission(role: string, key: keyof AgentRoleConfig['permissions']) {
    this.agentRoleConfigs[role].permissions[key] =
      !this.agentRoleConfigs[role].permissions[key];
  }

  getProvidersByCategory(category: string) {
    return PROVIDER_TYPES.filter((p) => p.category === category);
  }

  getAgentColorClass(role: string): string {
    const color = AGENT_ROLE_COLORS[role] ?? 'slate';
    return `bg-${color}-500/20 text-${color}-400`;
  }

  getRoleIcon(role: string): string {
    return this.agentRoleConfigs[role]?.icon ?? 'bot';
  }

  getRoleDescription(role: string): string {
    return this.agentRoleConfigs[role]?.description ?? '';
  }

  getRolePipelinePosition(role: string): number {
    return this.agentRoleConfigs[role]?.pipelinePosition ?? 0;
  }

  getRoleProvider(role: string): string {
    return this.agentRoleConfigs[role]?.provider ?? 'OLLAMA';
  }

  getRoleModel(role: string): string {
    return this.agentRoleConfigs[role]?.model ?? 'llama3.1';
  }

  // ─── MCP Servers ─────────────────────────────────────────────

  loadMcpServers() {
    this.api.getMcpServers().subscribe({
      next: (servers) => this.mcpServers.set(servers),
    });
  }

  toggleMcpServerEnabled(server: McpServerDefinition, event: Event) {
    event.stopPropagation();
    this.api.updateMcpServer(server.id, { enabled: !server.enabled } as any).subscribe({
      next: () => this.loadMcpServers(),
    });
  }

  toggleMcpServerRole(server: McpServerDefinition, role: string) {
    const roles = server.roles.includes(role)
      ? server.roles.filter((r) => r !== role)
      : [...server.roles, role];
    this.api.setMcpServerRoles(server.id, roles).subscribe({
      next: () => this.loadMcpServers(),
    });
  }

  deleteMcpServer(server: McpServerDefinition) {
    if (!confirm(this.i18n.t('settings.mcpDeleteConfirm'))) return;
    this.api.deleteMcpServer(server.id).subscribe({
      next: () => {
        this.loadMcpServers();
        this.showToast('success', this.i18n.t('settings.mcpServerDeleted'));
      },
      error: () => this.showToast('error', this.i18n.t('settings.savedError')),
    });
  }

  addMcpServer() {
    const dto = {
      ...this.newMcpServer,
      args: this.newMcpServerArgsText.split(/\s+/).filter(Boolean),
    };
    this.api.createMcpServer(dto).subscribe({
      next: () => {
        this.loadMcpServers();
        this.showAddMcpServer = false;
        this.newMcpServer = {};
        this.newMcpServerArgsText = '';
        this.showToast('success', this.i18n.t('settings.mcpServerCreated'));
      },
      error: () => this.showToast('error', this.i18n.t('settings.savedError')),
    });
  }

  // ─── Private ─────────────────────────────────────────────────

  private pushSecretSetting(
    settings: { key: string; value: string; category?: string; encrypted?: boolean }[],
    key: string,
    category: string,
  ) {
    const currentValue = this.sysValues[key] ?? '';
    const originalMasked = this.originalMaskedValues[key] ?? '';

    if (currentValue !== originalMasked) {
      settings.push({ key, value: currentValue, category, encrypted: true });
    }
  }

  private showToast(type: 'success' | 'error', message: string) {
    this.toast.set({ type, message });
    setTimeout(() => this.toast.set(null), 3000);
  }
}
