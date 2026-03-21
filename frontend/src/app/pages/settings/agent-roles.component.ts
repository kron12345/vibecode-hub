import { Component, inject, OnInit, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  ApiService,
  AgentRoleConfig,
  AgentPresetInfo,
  PipelineConfig,
  ProviderModel,
  ProviderModelsResult,
  CliToolStatus,
  McpServerDefinition,
} from '../../services/api.service';
import { IconComponent } from '../../components/icon.component';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { TranslateService } from '../../services/translate.service';

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
  { value: 'GEMINI_CLI', label: 'Gemini CLI', category: 'cli' },
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
  selector: 'app-agent-roles',
  standalone: true,
  imports: [FormsModule, IconComponent, TranslatePipe],
  template: `
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

        <!-- Advanced Pipeline Tuning -->
        <div class="border-t border-white/5 pt-4 mt-4">
          <h3 class="text-sm font-semibold text-slate-500 mb-4 flex items-center gap-2">
            <app-icon name="sliders-horizontal" [size]="14" />
            {{ 'settings.advancedTuning' | translate }}
          </h3>
          <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label class="block text-xs font-medium text-slate-500 mb-1">
                {{ 'settings.mcpMaxIterations' | translate }}
              </label>
              <p class="text-[10px] text-slate-600 mb-1">{{ 'settings.mcpMaxIterationsHint' | translate }}</p>
              <input
                type="number"
                [(ngModel)]="pipelineConfig.mcpMaxIterations"
                min="5"
                max="100"
                placeholder="30"
                class="w-full bg-slate-900/50 border border-white/10 rounded-xl px-4 py-2.5 text-white text-sm focus:outline-none focus:border-indigo-500/50 transition-colors"
              />
            </div>
            <div>
              <label class="block text-xs font-medium text-slate-500 mb-1">
                {{ 'settings.maxInterviewMessages' | translate }}
              </label>
              <p class="text-[10px] text-slate-600 mb-1">{{ 'settings.maxInterviewMessagesHint' | translate }}</p>
              <input
                type="number"
                [(ngModel)]="pipelineConfig.maxInterviewMessages"
                min="10"
                max="200"
                placeholder="50"
                class="w-full bg-slate-900/50 border border-white/10 rounded-xl px-4 py-2.5 text-white text-sm focus:outline-none focus:border-indigo-500/50 transition-colors"
              />
            </div>
            <div>
              <label class="block text-xs font-medium text-slate-500 mb-1">
                {{ 'settings.stuckCheckInterval' | translate }}
              </label>
              <p class="text-[10px] text-slate-600 mb-1">{{ 'settings.stuckCheckIntervalHint' | translate }}</p>
              <input
                type="number"
                [(ngModel)]="pipelineConfig.stuckCheckIntervalMinutes"
                min="1"
                max="60"
                placeholder="5"
                class="w-full bg-slate-900/50 border border-white/10 rounded-xl px-4 py-2.5 text-white text-sm focus:outline-none focus:border-indigo-500/50 transition-colors"
              />
            </div>
            <div>
              <label class="block text-xs font-medium text-slate-500 mb-1">
                {{ 'settings.gitTimeout' | translate }}
              </label>
              <p class="text-[10px] text-slate-600 mb-1">{{ 'settings.gitTimeoutHint' | translate }}</p>
              <input
                type="number"
                [(ngModel)]="pipelineConfig.gitTimeoutSeconds"
                min="10"
                max="600"
                placeholder="60"
                class="w-full bg-slate-900/50 border border-white/10 rounded-xl px-4 py-2.5 text-white text-sm focus:outline-none focus:border-indigo-500/50 transition-colors"
              />
            </div>
            <div>
              <label class="block text-xs font-medium text-slate-500 mb-1">
                {{ 'settings.cliTimeout' | translate }}
              </label>
              <p class="text-[10px] text-slate-600 mb-1">{{ 'settings.cliTimeoutHint' | translate }}</p>
              <input
                type="number"
                [(ngModel)]="pipelineConfig.cliTimeoutMinutes"
                min="1"
                max="360"
                placeholder="90"
                class="w-full bg-slate-900/50 border border-white/10 rounded-xl px-4 py-2.5 text-white text-sm focus:outline-none focus:border-indigo-500/50 transition-colors"
              />
            </div>
            <div>
              <label class="block text-xs font-medium text-slate-500 mb-1">
                {{ 'settings.maxReviewDiffs' | translate }}
              </label>
              <p class="text-[10px] text-slate-600 mb-1">{{ 'settings.maxReviewDiffsHint' | translate }}</p>
              <input
                type="number"
                [(ngModel)]="pipelineConfig.maxReviewDiffs"
                min="5"
                max="100"
                placeholder="25"
                class="w-full bg-slate-900/50 border border-white/10 rounded-xl px-4 py-2.5 text-white text-sm focus:outline-none focus:border-indigo-500/50 transition-colors"
              />
            </div>
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

              <!-- Row 1b: Dual-Testing -->
              <div class="border border-white/5 rounded-xl p-4 bg-slate-900/30">
                <div class="flex items-center justify-between mb-3">
                  <div class="flex items-center gap-2">
                    <app-icon name="git-compare" [size]="16" class="text-amber-400" />
                    <span class="text-sm font-medium text-slate-400">{{ 'settings.dualTesting' | translate }}</span>
                  </div>
                  <label class="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      [checked]="!!agentRoleConfigs[role].dualProvider"
                      (change)="toggleDualTesting(role)"
                      class="sr-only peer"
                    />
                    <div class="w-9 h-5 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-amber-500"></div>
                  </label>
                </div>
                @if (agentRoleConfigs[role].dualProvider) {
                  <p class="text-[10px] text-slate-600 mb-3">{{ 'settings.dualTestingHint' | translate }}</p>
                  <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <div>
                      <label class="block text-[10px] font-medium text-slate-500 mb-1">{{ 'settings.dualProvider' | translate }}</label>
                      <div class="relative">
                        <select
                          [(ngModel)]="agentRoleConfigs[role].dualProvider"
                          class="w-full appearance-none bg-slate-800/50 border border-amber-500/20 rounded-lg pl-3 pr-8 py-2 text-white text-sm focus:outline-none focus:border-amber-500/40 transition-colors cursor-pointer"
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
                        <app-icon name="chevron-down" [size]="12" class="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
                      </div>
                    </div>
                    <div>
                      <label class="block text-[10px] font-medium text-slate-500 mb-1">{{ 'settings.dualModel' | translate }}</label>
                      <input
                        type="text"
                        [(ngModel)]="agentRoleConfigs[role].dualModel"
                        class="w-full bg-slate-800/50 border border-amber-500/20 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500/40 transition-colors"
                        placeholder="sonnet, opus, haiku, ..."
                      />
                    </div>
                    <div>
                      <label class="block text-[10px] font-medium text-slate-500 mb-1">{{ 'settings.dualStrategy' | translate }}</label>
                      <div class="relative">
                        <select
                          [(ngModel)]="agentRoleConfigs[role].dualStrategy"
                          class="w-full appearance-none bg-slate-800/50 border border-amber-500/20 rounded-lg pl-3 pr-8 py-2 text-white text-sm focus:outline-none focus:border-amber-500/40 transition-colors cursor-pointer"
                        >
                          <option value="merge">Merge ({{ 'settings.dualMerge' | translate }})</option>
                          <option value="consensus">Consensus ({{ 'settings.dualConsensus' | translate }})</option>
                          <option value="enrich">Enrich ({{ 'settings.dualEnrich' | translate }})</option>
                        </select>
                        <app-icon name="chevron-down" [size]="12" class="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
                      </div>
                    </div>
                  </div>
                }
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

              <!-- Row 3b: Reasoning Toggle -->
              <div class="flex items-center justify-between">
                <div>
                  <span class="text-sm font-medium text-slate-400">{{ 'settings.enableReasoning' | translate }}</span>
                  <p class="text-xs text-slate-600">{{ 'settings.enableReasoningHint' | translate }}</p>
                </div>
                <label class="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    [checked]="agentRoleConfigs[role].enableReasoning"
                    (change)="agentRoleConfigs[role].enableReasoning = !agentRoleConfigs[role].enableReasoning"
                    class="sr-only peer"
                  />
                  <div class="w-11 h-6 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-violet-500"></div>
                </label>
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
  `,
})
export class AgentRolesComponent implements OnInit {
  private api = inject(ApiService);
  private i18n = inject(TranslateService);

  saved = output<{ type: 'success' | 'error'; message: string }>();

  saving = signal(false);

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
    cliTimeoutMinutes: 90,
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

    // Auto-load agent data when component is created (it lives behind @if)
    this.loadAgentData();
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
        this.pipelineConfig = {
          ...this.pipelineConfig,
          ...config,
          cliTimeoutMinutes: config.cliTimeoutMinutes ?? 90,
        };
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

    this.api.getProviderModels().subscribe({
      next: (results) => {
        this.providerResults.set(results);
        this.modelsLoading.set(false);
      },
      error: () => {
        this.modelsLoading.set(false);
      },
    });

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
      GEMINI_CLI: 'Gemini CLI',
      QWEN3_CODER: 'Qwen3 Coder',
    };
    return labels[provider] ?? provider;
  }

  saveAgentSettings() {
    this.saving.set(true);

    const settings: {
      key: string;
      value: string;
      category?: string;
    }[] = [];

    for (const role of AGENT_ROLES) {
      settings.push({
        key: `agents.roles.${role}`,
        value: JSON.stringify(this.agentRoleConfigs[role]),
        category: 'agents',
      });
    }

    settings.push({
      key: 'agents.pipeline',
      value: JSON.stringify(this.pipelineConfig),
      category: 'agents',
    });

    this.api.updateSystemSettings(settings).subscribe({
      next: () => {
        this.saving.set(false);
        this.saved.emit({ type: 'success', message: this.i18n.t('settings.agentsSaved') });
      },
      error: () => {
        this.saving.set(false);
        this.saved.emit({ type: 'error', message: this.i18n.t('settings.savedError') });
      },
    });
  }

  applyPreset(presetId: string) {
    this.applyingPreset.set(true);
    this.api.applyAgentPreset(presetId).subscribe({
      next: (result) => {
        this.api.getAgentRoleConfigs().subscribe({
          next: (configs) => {
            for (const [role, config] of Object.entries(configs)) {
              this.agentRoleConfigs[role] = { ...config };
            }
            this.applyingPreset.set(false);
            this.saved.emit({ type: 'success', message: this.i18n.t('settings.presetApplied', { name: result.name }) });
          },
        });
      },
      error: () => {
        this.applyingPreset.set(false);
        this.saved.emit({ type: 'error', message: this.i18n.t('settings.savedError') });
      },
    });
  }

  // -- Agent Role Helpers --

  toggleRoleExpanded(role: string) {
    this.expandedRoles[role] = !this.expandedRoles[role];
  }

  toggleDualTesting(role: string) {
    if (this.agentRoleConfigs[role].dualProvider) {
      delete this.agentRoleConfigs[role].dualProvider;
      delete this.agentRoleConfigs[role].dualModel;
      delete this.agentRoleConfigs[role].dualStrategy;
    } else {
      this.agentRoleConfigs[role].dualProvider = 'CLAUDE_CODE';
      this.agentRoleConfigs[role].dualModel = 'sonnet';
      this.agentRoleConfigs[role].dualStrategy = 'merge';
    }
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

  // -- MCP Servers --

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
        this.saved.emit({ type: 'success', message: this.i18n.t('settings.mcpServerDeleted') });
      },
      error: () => this.saved.emit({ type: 'error', message: this.i18n.t('settings.savedError') }),
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
        this.saved.emit({ type: 'success', message: this.i18n.t('settings.mcpServerCreated') });
      },
      error: () => this.saved.emit({ type: 'error', message: this.i18n.t('settings.savedError') }),
    });
  }
}
