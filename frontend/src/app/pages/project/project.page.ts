import {
  Component,
  inject,
  OnInit,
  OnDestroy,
  signal,
  viewChild,
  effect,
  computed,
} from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import {
  ApiService,
  Project,
  ProjectStatus,
  Issue,
  Milestone,
  ChatSession,
  McpServerDefinition,
  McpProjectOverride,
  PipelineFailureSummary,
} from '../../services/api.service';
import { ChatSocketService } from '../../services/chat-socket.service';
import { VoiceService } from '../../services/voice.service';
import { IconComponent } from '../../components/icon.component';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { TranslateService } from '../../services/translate.service';

import { PipelineViewComponent, AGENT_CONFIG, AgentEntry } from './pipeline-view.component';
import { ChatPanelComponent } from './chat-panel.component';
import { IssueBoardComponent, MilestoneGroup } from './issue-board.component';

const PROJECT_STATUSES: ProjectStatus[] = ['INTERVIEWING', 'SETTING_UP', 'READY', 'ARCHIVED'];

type Tab = 'overview' | 'settings';

@Component({
  selector: 'app-project',
  imports: [
    FormsModule,
    RouterLink,
    IconComponent,
    TranslatePipe,
    PipelineViewComponent,
    ChatPanelComponent,
    IssueBoardComponent,
  ],
  template: `
    @if (project(); as p) {
      <!-- Header -->
      <div class="flex items-start justify-between gap-6 mb-6">
        <div class="min-w-0 flex-1">
          <a routerLink="/" class="text-slate-500 text-sm hover:text-indigo-400 transition-colors flex items-center gap-1 mb-2 animate-in stagger-1">
            <app-icon name="arrow-left" [size]="14" /> {{ 'project.backToDashboard' | translate }}
          </a>
          <h1 class="text-3xl font-extrabold tracking-tight bg-gradient-to-r from-white via-indigo-200 to-slate-500 bg-clip-text text-transparent animate-in stagger-2">
            {{ p.name }}
          </h1>
          <p class="text-slate-500 mt-1 line-clamp-2 text-sm">
            {{ p.description }}
            @if (p.gitlabUrl) {
              <span class="mx-2 text-slate-700">&middot;</span>
              <a [href]="p.gitlabUrl" target="_blank" class="text-indigo-400 hover:text-indigo-300 font-mono text-sm">
                <app-icon name="git-branch" [size]="12" class="inline" /> GitLab
              </a>
            }
            @if (p.previewPort) {
              <span class="mx-2 text-slate-700">&middot;</span>
              <span class="text-emerald-400/60 font-mono text-sm">
                <app-icon name="globe" [size]="12" class="inline" /> {{ p.slug }}.hub.example.com
              </span>
            }
          </p>
        </div>
        @if (p.previewPort) {
          <a [href]="'https://' + p.slug + '.hub.example.com'" target="_blank"
            class="shrink-0 flex items-center gap-2 px-5 py-2.5 rounded-xl bg-emerald-500/15 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/25 hover:border-emerald-500/40 transition-all text-sm font-medium shadow-lg shadow-emerald-500/5 animate-in stagger-2 whitespace-nowrap">
            <app-icon name="globe" [size]="16" />
            {{ 'project.openPreview' | translate }}
            <app-icon name="external-link" [size]="14" class="opacity-50" />
          </a>
        }
      </div>

      <!-- Tabs -->
      <div class="flex gap-2 mb-6 animate-in stagger-3">
        <button
          (click)="activeTab.set('overview')"
          class="px-4 py-2 rounded-xl text-sm font-medium transition-all"
          [class]="activeTab() === 'overview' ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/20' : 'text-slate-400 hover:text-white hover:bg-white/5'"
        >
          <app-icon name="layout-dashboard" [size]="16" class="inline mr-2" />
          {{ 'project.tabOverview' | translate }}
        </button>
        <button
          (click)="activeTab.set('settings')"
          class="px-4 py-2 rounded-xl text-sm font-medium transition-all"
          [class]="activeTab() === 'settings' ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/20' : 'text-slate-400 hover:text-white hover:bg-white/5'"
        >
          <app-icon name="settings" [size]="16" class="inline mr-2" />
          {{ 'project.tabSettings' | translate }}
        </button>
      </div>

      <!-- TAB: Overview -->
      @if (activeTab() === 'overview') {
        <app-pipeline-view
          [agentEntries]="agentEntries()"
          [hasWorkingAgent]="hasWorkingAgent()"
          [failure]="latestFailure()"
          [showFailure]="!!activeSession() && !!latestFailure()"
          [resuming]="resumingFailure()"
          (resume)="resumePipelineFromFailure()"
        />

        <!-- Main Content: Issues + Chat/Terminal -->
        <div class="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4">
          <app-issue-board
            [issues]="issues()"
            [issuesByMilestone]="issuesByMilestone()"
          />

          <app-chat-panel
            #chatPanel
            [projectId]="p.id"
            [projectSlug]="p.slug"
            [activeSession]="activeSession()"
            [hasWorkingAgent]="hasWorkingAgent()"
            [infraSession]="infraSession()"
            [devSessions]="devSessions()"
            [archivedSessions]="archivedSessions()"
            (sessionOpened)="openSession($event)"
            (closeSessionClicked)="closeSession()"
            (archiveConfirmed)="confirmArchiveSession()"
            (devSessionCreated)="createDevSession($event)"
            (resumePipeline)="resumePipelineFromFailure()"
          />
        </div>
      }

      <!-- TAB: Settings -->
      @if (activeTab() === 'settings') {
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">

          <!-- Card 1: General -->
          <div class="glass card-glow rounded-2xl p-6 border border-white/5 animate-in stagger-1">
            <div class="flex items-center gap-3 mb-5">
              <div class="p-2 rounded-xl bg-indigo-500/20 text-indigo-400">
                <app-icon name="info" [size]="18" />
              </div>
              <h3 class="text-sm font-bold text-white uppercase tracking-widest">{{ 'project.settings.general' | translate }}</h3>
            </div>
            <div class="space-y-4">
              <div>
                <label class="block text-xs text-slate-500 mb-1">{{ 'project.settings.name' | translate }}</label>
                <input type="text" [(ngModel)]="settingsName" class="w-full bg-black/40 rounded-xl px-4 py-2.5 text-sm text-white border border-white/5 outline-none focus:border-indigo-500/50 transition-colors" />
              </div>
              <div>
                <label class="block text-xs text-slate-500 mb-1">{{ 'project.settings.description' | translate }}</label>
                <textarea [(ngModel)]="settingsDescription" rows="2" class="w-full bg-black/40 rounded-xl px-4 py-2.5 text-sm text-white border border-white/5 outline-none focus:border-indigo-500/50 transition-colors resize-none"></textarea>
              </div>
              <div>
                <label class="block text-xs text-slate-500 mb-1">{{ 'project.settings.status' | translate }}</label>
                <div class="relative">
                  <select [(ngModel)]="settingsStatus" class="w-full bg-black/40 rounded-xl px-4 py-2.5 text-sm text-white border border-white/5 outline-none focus:border-indigo-500/50 transition-colors appearance-none pr-10">
                    @for (s of projectStatuses; track s) {
                      <option [value]="s">{{ s }}</option>
                    }
                  </select>
                  <app-icon name="chevron-down" [size]="14" class="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
                </div>
              </div>
              <div>
                <label class="block text-xs text-slate-500 mb-1">{{ 'project.settings.workBranch' | translate }}</label>
                <input type="text" [(ngModel)]="settingsWorkBranch" placeholder="main (default)" class="w-full bg-black/40 rounded-xl px-4 py-2.5 text-sm text-white border border-white/5 outline-none focus:border-indigo-500/50 transition-colors placeholder-slate-600" />
                <p class="text-xs text-slate-600 mt-1">{{ 'project.settings.workBranchHint' | translate }}</p>
              </div>
              <div>
                <label class="block text-xs text-slate-500 mb-1">{{ 'project.settings.maxFixAttempts' | translate }}</label>
                <input type="number" [(ngModel)]="settingsMaxFixAttempts" [placeholder]="'project.settings.maxFixAttemptsPlaceholder' | translate" min="1" max="50" class="w-full bg-black/40 rounded-xl px-4 py-2.5 text-sm text-white border border-white/5 outline-none focus:border-indigo-500/50 transition-colors placeholder-slate-600" />
                <p class="text-xs text-slate-600 mt-1">{{ 'project.settings.maxFixAttemptsHint' | translate }}</p>
              </div>
              <div>
                <label class="block text-xs text-slate-500 mb-1">{{ 'project.settings.slug' | translate }}</label>
                <input type="text" [value]="p.slug" disabled class="w-full bg-black/20 rounded-xl px-4 py-2.5 text-sm text-slate-500 border border-white/5 cursor-not-allowed" />
              </div>
              <div>
                <label class="block text-xs text-slate-500 mb-1">{{ 'project.settings.createdAt' | translate }}</label>
                <input type="text" [value]="formatDate(p.createdAt)" disabled class="w-full bg-black/20 rounded-xl px-4 py-2.5 text-sm text-slate-500 border border-white/5 cursor-not-allowed" />
              </div>
            </div>
          </div>

          <!-- Card 2: Tech Stack -->
          <div class="glass card-glow rounded-2xl p-6 border border-white/5 animate-in stagger-2">
            <div class="flex items-center gap-3 mb-5">
              <div class="p-2 rounded-xl bg-violet-500/20 text-violet-400">
                <app-icon name="layers" [size]="18" />
              </div>
              <h3 class="text-sm font-bold text-white uppercase tracking-widest">{{ 'project.settings.techStack' | translate }}</h3>
            </div>
            <div class="space-y-4">
              <div>
                <label class="block text-xs text-slate-500 mb-1">{{ 'project.settings.framework' | translate }}</label>
                <input type="text" [(ngModel)]="settingsFramework" class="w-full bg-black/40 rounded-xl px-4 py-2.5 text-sm text-white border border-white/5 outline-none focus:border-violet-500/50 transition-colors" />
              </div>
              <div>
                <label class="block text-xs text-slate-500 mb-1">{{ 'project.settings.language' | translate }}</label>
                <input type="text" [(ngModel)]="settingsLanguage" class="w-full bg-black/40 rounded-xl px-4 py-2.5 text-sm text-white border border-white/5 outline-none focus:border-violet-500/50 transition-colors" />
              </div>
              <div>
                <label class="block text-xs text-slate-500 mb-1">{{ 'project.settings.backend' | translate }}</label>
                <input type="text" [(ngModel)]="settingsBackend" class="w-full bg-black/40 rounded-xl px-4 py-2.5 text-sm text-white border border-white/5 outline-none focus:border-violet-500/50 transition-colors" />
              </div>
              <div>
                <label class="block text-xs text-slate-500 mb-1">{{ 'project.settings.database' | translate }}</label>
                <input type="text" [(ngModel)]="settingsDatabase" class="w-full bg-black/40 rounded-xl px-4 py-2.5 text-sm text-white border border-white/5 outline-none focus:border-violet-500/50 transition-colors" />
              </div>
              <div>
                <label class="block text-xs text-slate-500 mb-1">{{ 'project.settings.additionalPackages' | translate }}</label>
                <input type="text" [(ngModel)]="settingsAdditional" class="w-full bg-black/40 rounded-xl px-4 py-2.5 text-sm text-white border border-white/5 outline-none focus:border-violet-500/50 transition-colors" [placeholder]="'project.settings.additionalPackagesHint' | translate" />
              </div>
            </div>
          </div>

          <!-- Card 3: Deployment & Preview -->
          <div class="glass card-glow rounded-2xl p-6 border border-white/5 animate-in stagger-3">
            <div class="flex items-center gap-3 mb-5">
              <div class="p-2 rounded-xl bg-emerald-500/20 text-emerald-400">
                <app-icon name="rocket" [size]="18" />
              </div>
              <h3 class="text-sm font-bold text-white uppercase tracking-widest">{{ 'project.settings.deployment' | translate }}</h3>
            </div>
            <div class="space-y-4">
              <div class="flex items-center justify-between">
                <div>
                  <label class="text-sm text-white">{{ 'project.settings.isWebProject' | translate }}</label>
                  <p class="text-xs text-slate-500">{{ 'project.settings.isWebProjectHint' | translate }}</p>
                </div>
                <label class="relative inline-flex items-center cursor-pointer">
                  <input type="checkbox" [(ngModel)]="settingsIsWeb" class="sr-only peer" />
                  <div class="w-9 h-5 rounded-full bg-slate-700 peer-checked:bg-emerald-600 after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-full"></div>
                </label>
              </div>
              <div>
                <label class="block text-xs text-slate-500 mb-1">{{ 'project.settings.devServerPort' | translate }}</label>
                <input type="number" [(ngModel)]="settingsDevPort" class="w-full bg-black/40 rounded-xl px-4 py-2.5 text-sm text-white border border-white/5 outline-none focus:border-emerald-500/50 transition-colors" />
              </div>
              <div>
                <label class="block text-xs text-slate-500 mb-1">{{ 'project.settings.devServerCommand' | translate }}</label>
                <input type="text" [(ngModel)]="settingsDevCmd" class="w-full bg-black/40 rounded-xl px-4 py-2.5 text-sm text-white font-mono border border-white/5 outline-none focus:border-emerald-500/50 transition-colors" />
              </div>
              <div>
                <label class="block text-xs text-slate-500 mb-1">{{ 'project.settings.buildCommand' | translate }}</label>
                <input type="text" [(ngModel)]="settingsBuildCmd" class="w-full bg-black/40 rounded-xl px-4 py-2.5 text-sm text-white font-mono border border-white/5 outline-none focus:border-emerald-500/50 transition-colors" />
              </div>
              <div>
                <label class="block text-xs text-slate-500 mb-1">{{ 'project.settings.previewPort' | translate }}</label>
                <input type="text" [value]="p.previewPort ?? '---'" disabled class="w-full bg-black/20 rounded-xl px-4 py-2.5 text-sm text-slate-500 border border-white/5 cursor-not-allowed" />
                <p class="text-[10px] text-slate-600 mt-1">{{ 'project.settings.previewPortHint' | translate }}</p>
              </div>
            </div>
          </div>

          <!-- Card 4: GitLab -->
          <div class="glass card-glow rounded-2xl p-6 border border-white/5 animate-in stagger-4">
            <div class="flex items-center gap-3 mb-5">
              <div class="p-2 rounded-xl bg-orange-500/20 text-orange-400">
                <app-icon name="git-branch" [size]="18" />
              </div>
              <h3 class="text-sm font-bold text-white uppercase tracking-widest">{{ 'project.settings.gitlab' | translate }}</h3>
            </div>
            <div class="space-y-4">
              <div>
                <label class="block text-xs text-slate-500 mb-1">{{ 'project.settings.gitlabUrl' | translate }}</label>
                <input type="text" [value]="p.gitlabUrl ?? '---'" disabled class="w-full bg-black/20 rounded-xl px-4 py-2.5 text-sm text-slate-500 border border-white/5 cursor-not-allowed font-mono" />
              </div>
              <div>
                <label class="block text-xs text-slate-500 mb-1">{{ 'project.settings.gitlabProjectId' | translate }}</label>
                <input type="text" [value]="p.gitlabProjectId ?? '---'" disabled class="w-full bg-black/20 rounded-xl px-4 py-2.5 text-sm text-slate-500 border border-white/5 cursor-not-allowed font-mono" />
              </div>
            </div>
          </div>

          <!-- Card 5: Setup Commands -->
          <div class="glass card-glow rounded-2xl p-6 border border-white/5 animate-in stagger-5">
            <div class="flex items-center gap-3 mb-5">
              <div class="p-2 rounded-xl bg-amber-500/20 text-amber-400">
                <app-icon name="terminal" [size]="18" />
              </div>
              <h3 class="text-sm font-bold text-white uppercase tracking-widest">{{ 'project.settings.setup' | translate }}</h3>
            </div>
            <div class="space-y-4">
              <div>
                <label class="block text-xs text-slate-500 mb-1">{{ 'project.settings.initCommand' | translate }}</label>
                <input type="text" [(ngModel)]="settingsInitCmd" class="w-full bg-black/40 rounded-xl px-4 py-2.5 text-sm text-white font-mono border border-white/5 outline-none focus:border-amber-500/50 transition-colors" />
              </div>
              <div>
                <label class="block text-xs text-slate-500 mb-1">{{ 'project.settings.additionalCommands' | translate }}</label>
                <textarea [(ngModel)]="settingsAdditionalCmds" rows="4" class="w-full bg-black/40 rounded-xl px-4 py-2.5 text-sm text-white font-mono border border-white/5 outline-none focus:border-amber-500/50 transition-colors resize-none" [placeholder]="'project.settings.additionalCommandsHint' | translate"></textarea>
              </div>
            </div>
          </div>

          <!-- Card 6: Interview Results -->
          <div class="glass card-glow rounded-2xl p-6 border border-white/5 animate-in stagger-6">
            <div class="flex items-center gap-3 mb-5">
              <div class="p-2 rounded-xl bg-sky-500/20 text-sky-400">
                <app-icon name="message-circle" [size]="18" />
              </div>
              <h3 class="text-sm font-bold text-white uppercase tracking-widest">{{ 'project.settings.interviewResults' | translate }}</h3>
            </div>
            <p class="text-xs text-slate-600 mb-4">{{ 'project.settings.interviewHint' | translate }}</p>
            <div class="space-y-4">
              <div>
                <label class="block text-xs text-slate-500 mb-2">{{ 'project.settings.features' | translate }}</label>
                <div class="flex flex-wrap gap-2">
                  @for (f of interviewFeatures(); track f) {
                    <span class="px-3 py-1 rounded-full bg-sky-500/10 text-sky-400 text-xs font-medium border border-sky-500/20">{{ f }}</span>
                  }
                  @if (interviewFeatures().length === 0) {
                    <span class="text-xs text-slate-600">{{ 'project.settings.noFeatures' | translate }}</span>
                  }
                </div>
              </div>
              <div>
                <label class="block text-xs text-slate-500 mb-2">{{ 'project.settings.mcpServers' | translate }}</label>
                @for (mcp of interviewMcpServers(); track mcp.name) {
                  <div class="bg-black/30 rounded-xl p-3 mb-2">
                    <span class="text-sm text-white font-medium">{{ mcp.name }}</span>
                    @if (mcp.purpose) {
                      <p class="text-xs text-slate-500 mt-1">{{ mcp.purpose }}</p>
                    }
                  </div>
                }
                @if (interviewMcpServers().length === 0) {
                  <span class="text-xs text-slate-600">{{ 'project.settings.noMcpServers' | translate }}</span>
                }
              </div>
            </div>
          </div>

          <!-- Card 7: MCP Server Overrides -->
          <div class="glass card-glow rounded-2xl p-6 border border-white/5 animate-in stagger-7 col-span-full">
            <div class="flex items-center gap-3 mb-5">
              <div class="p-2 rounded-xl bg-purple-500/20 text-purple-400">
                <app-icon name="plug" [size]="18" />
              </div>
              <h3 class="text-sm font-bold text-white uppercase tracking-widest">{{ 'project.settings.mcpOverrides' | translate }}</h3>
            </div>
            <p class="text-xs text-slate-600 mb-4">{{ 'project.settings.mcpOverridesHint' | translate }}</p>

            @if (mcpServers().length > 0) {
              <div class="overflow-x-auto">
                <table class="w-full text-xs">
                  <thead>
                    <tr class="border-b border-white/5">
                      <th class="text-left py-2 px-3 text-slate-500 font-medium">{{ 'project.settings.mcpServer' | translate }}</th>
                      @for (role of mcpRoles; track role) {
                        <th class="text-center py-2 px-1 text-slate-500 font-medium" [title]="role">
                          {{ role.substring(0, 3) }}
                        </th>
                      }
                    </tr>
                  </thead>
                  <tbody>
                    @for (server of mcpServers(); track server.id) {
                      <tr class="border-b border-white/5 hover:bg-white/[0.02]">
                        <td class="py-2 px-3">
                          <div class="flex items-center gap-2">
                            <span class="text-white font-medium">{{ server.displayName }}</span>
                            @if (server.builtin) {
                              <span class="px-1.5 py-0.5 rounded bg-slate-700 text-slate-400 text-[9px] uppercase">built-in</span>
                            }
                          </div>
                        </td>
                        @for (role of mcpRoles; track role) {
                          <td class="text-center py-2 px-1">
                            <button
                              (click)="cycleOverride(server.id, role)"
                              class="w-6 h-6 rounded-md flex items-center justify-center transition-all text-[10px] font-bold"
                              [class]="getOverrideState(server.id, role) === 'enable'
                                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                                : getOverrideState(server.id, role) === 'disable'
                                  ? 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                                  : isGloballyAssigned(server.id, role)
                                    ? 'bg-white/5 text-slate-400 border border-white/10'
                                    : 'bg-transparent text-slate-700 border border-white/5'"
                              [title]="getOverrideState(server.id, role) === 'enable'
                                ? 'Override: Enabled (click to disable)'
                                : getOverrideState(server.id, role) === 'disable'
                                  ? 'Override: Disabled (click to reset)'
                                  : isGloballyAssigned(server.id, role)
                                    ? 'Global: Enabled (click to override)'
                                    : 'Global: Disabled (click to override)'"
                            >
                              @if (getOverrideState(server.id, role) === 'enable') {
                                +
                              } @else if (getOverrideState(server.id, role) === 'disable') {
                                -
                              } @else if (isGloballyAssigned(server.id, role)) {
                                &middot;
                              }
                            </button>
                          </td>
                        }
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
              <div class="flex gap-4 mt-3 text-[10px] text-slate-600">
                <span><span class="inline-block w-3 h-3 rounded bg-white/5 border border-white/10 mr-1"></span>{{ 'project.settings.mcpGlobal' | translate }}</span>
                <span><span class="inline-block w-3 h-3 rounded bg-emerald-500/20 border border-emerald-500/30 mr-1"></span>{{ 'project.settings.mcpOverrideOn' | translate }}</span>
                <span><span class="inline-block w-3 h-3 rounded bg-rose-500/20 border border-rose-500/30 mr-1"></span>{{ 'project.settings.mcpOverrideOff' | translate }}</span>
              </div>
            } @else {
              <p class="text-xs text-slate-600">{{ 'project.settings.mcpNoServers' | translate }}</p>
            }
          </div>
        </div>

        <!-- Save Button -->
        <div class="flex items-center gap-4 mt-6 animate-in stagger-7">
          <button
            (click)="saveProjectSettings()"
            [disabled]="saving()"
            class="px-6 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 hover:shadow-lg hover:shadow-indigo-500/25 hover:scale-[1.02] text-white text-sm font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            @if (saving()) {
              <app-icon name="loader-2" [size]="16" class="animate-spin" />
              {{ 'common.saving' | translate }}
            } @else {
              <app-icon name="save" [size]="16" />
              {{ 'common.save' | translate }}
            }
          </button>
          @if (toast()) {
            <span
              class="text-sm font-medium animate-fade-in"
              [class]="toast() === 'success' ? 'text-emerald-400' : 'text-rose-400'"
            >
              {{ (toast() === 'success' ? 'project.settings.savedSuccess' : 'project.settings.savedError') | translate }}
            </span>
          }
        </div>
      }
    } @else {
      <!-- Skeleton Loading -->
      <div class="space-y-6">
        <div class="skeleton h-10 w-1/3"></div>
        <div class="skeleton h-5 w-1/2"></div>
        <div class="glass rounded-[2rem] p-6">
          <div class="flex gap-4">
            @for (i of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]; track i) {
              <div class="flex-1 skeleton h-28 rounded-2xl"></div>
            }
          </div>
        </div>
        <div class="grid grid-cols-[280px_1fr] gap-4">
          <div class="skeleton h-96 rounded-3xl"></div>
          <div class="skeleton h-96 rounded-3xl"></div>
        </div>
      </div>
    }
  `,
})
export class ProjectPage implements OnInit, OnDestroy {
  private route = inject(ActivatedRoute);
  private api = inject(ApiService);
  private chatSocket = inject(ChatSocketService);
  private voice = inject(VoiceService);
  i18n = inject(TranslateService);

  project = signal<Project | null>(null);
  issues = signal<Issue[]>([]);
  milestones = signal<Milestone[]>([]);
  sessions = signal<ChatSession[]>([]);
  activeSession = signal<ChatSession | null>(null);

  // Tab
  activeTab = signal<Tab>('overview');
  projectStatuses = PROJECT_STATUSES;

  // Settings form fields
  settingsName = '';
  settingsDescription = '';
  settingsWorkBranch = '';
  settingsMaxFixAttempts: number | null = null;
  settingsStatus: ProjectStatus = 'READY';
  settingsFramework = '';
  settingsLanguage = '';
  settingsBackend = '';
  settingsDatabase = '';
  settingsAdditional = '';
  settingsIsWeb = false;
  settingsDevPort: number | null = null;
  settingsDevCmd = '';
  settingsBuildCmd = '';
  settingsInitCmd = '';
  settingsAdditionalCmds = '';

  // Pipeline failure
  latestFailure = signal<PipelineFailureSummary | null>(null);
  resumingFailure = signal(false);

  saving = signal(false);
  toast = signal<'success' | 'error' | null>(null);

  // MCP Server Overrides
  mcpServers = signal<McpServerDefinition[]>([]);
  mcpOverrides = signal<McpProjectOverride[]>([]);
  mcpRoles = Object.keys(AGENT_CONFIG);

  // Child component refs
  chatPanelRef = viewChild<ChatPanelComponent>('chatPanel');

  private agentStatusSub: Subscription | null = null;
  private projectUpdatedSub: Subscription | null = null;

  /** Infrastructure session (always first, permanent) */
  infraSession = computed(() => this.sessions().find(s => s.type === 'INFRASTRUCTURE') ?? null);
  /** Active dev sessions */
  devSessions = computed(() =>
    this.sessions().filter(s => s.type === 'DEV_SESSION' && s.status !== 'ARCHIVED')
      .sort((a, b) => {
        const order: Record<string, number> = { ACTIVE: 0, MERGING: 1, CONFLICT: 2 };
        return (order[a.status] ?? 9) - (order[b.status] ?? 9);
      }),
  );
  /** Archived sessions */
  archivedSessions = computed(() =>
    this.sessions().filter(s => s.type === 'DEV_SESSION' && s.status === 'ARCHIVED'),
  );

  /** Build agent entries from the 10 roles, filling in instance data */
  agentEntries = computed<AgentEntry[]>(() => {
    const agents = this.project()?.agents ?? [];
    return Object.entries(AGENT_CONFIG).map(([role, cfg]) => ({
      role,
      ...cfg,
      instance: agents.find((a) => a.role === role),
    }));
  });

  hasWorkingAgent = computed(() =>
    (this.project()?.agents ?? []).some((a) => a.status === 'WORKING'),
  );

  /** Group issues by milestone, with ungrouped bucket */
  issuesByMilestone = computed<MilestoneGroup[]>(() => {
    const allIssues = this.issues();
    const allMilestones = this.milestones();
    const groups: MilestoneGroup[] = [];

    for (const ms of allMilestones) {
      groups.push({
        id: ms.id,
        title: ms.title,
        sortOrder: ms.sortOrder,
        issues: allIssues.filter(i => i.milestoneId === ms.id),
      });
    }

    const ungrouped = allIssues.filter(i => !i.milestoneId);
    if (ungrouped.length > 0) {
      groups.push({
        id: '_ungrouped',
        title: this.i18n.t('project.ungroupedIssues'),
        sortOrder: 999,
        issues: ungrouped,
      });
    }

    return groups.sort((a, b) => a.sortOrder - b.sortOrder);
  });

  /** Extract features from techStack interview results */
  interviewFeatures = computed(() => {
    const ts = this.project()?.techStack as Record<string, unknown> | null;
    if (!ts) return [];
    const features = ts['features'];
    return Array.isArray(features) ? features.map(String) : [];
  });

  /** Extract MCP servers from techStack */
  interviewMcpServers = computed(() => {
    const ts = this.project()?.techStack as Record<string, unknown> | null;
    if (!ts) return [];
    const mcpServers = ts['mcpServers'];
    if (!Array.isArray(mcpServers)) return [];
    return mcpServers.map((m: unknown) => {
      const obj = m as Record<string, unknown>;
      return { name: String(obj['name'] ?? ''), purpose: String(obj['purpose'] ?? '') };
    });
  });

  constructor() {
    // Populate settings form when project loads
    effect(() => {
      const p = this.project();
      if (p) this.populateSettingsForm(p);
    });
  }

  ngOnInit() {
    const slug = this.route.snapshot.paramMap.get('slug');
    if (slug) {
      this.api.getProject(slug).subscribe((p) => {
        this.project.set(p);
        this.loadIssues(p.id);
        this.loadMilestones(p.id);
        this.loadSessions(p.id);
        this.loadMcpData(p.id);

        // Auto-open interview session if project is in INTERVIEWING state
        if (p.status === 'INTERVIEWING') {
          this.api.getChatSessions(p.id).subscribe((sessions) => {
            const interviewSession = sessions.find(
              (s) => s.title === 'Project Interview',
            );
            if (interviewSession) {
              this.openSession(interviewSession);
            }
          });
        }
      });
    }

    // Listen for agent status changes to update pipeline visualization
    this.agentStatusSub = this.chatSocket.agentStatus$.subscribe((event) => {
      const p = this.project();
      if (p && event.projectId === p.id) {
        this.api.getProject(p.slug).subscribe((updated) => {
          this.project.set(updated);
        });

        const session = this.activeSession();
        if (session) {
          this.refreshLatestFailure(session.id);
        }

        // Reload issues + milestones when agents finish
        if (['ISSUE_COMPILER', 'CODER', 'CODE_REVIEWER'].includes(event.role) && event.status === 'IDLE') {
          this.loadIssues(p.id);
          this.loadMilestones(p.id);
        }
      }
    });

    // Listen for project updates (e.g., interview complete)
    this.projectUpdatedSub = this.chatSocket.projectUpdated$.subscribe(
      (event) => {
        const p = this.project();
        if (p && event.projectId === p.id) {
          this.api.getProject(p.slug).subscribe((updated) => {
            this.project.set(updated);
          });
        }
      },
    );
  }

  ngOnDestroy() {
    this.chatPanelRef()?.clearMessages();
    this.voice.teardownSocketListeners();
    this.agentStatusSub?.unsubscribe();
    this.projectUpdatedSub?.unsubscribe();
  }

  // ─── Session Management ─────────────────────────────────

  openSession(session: ChatSession) {
    this.activeSession.set(session);
    this.chatPanelRef()?.loadMessages(session.id);
    this.refreshLatestFailure(session.id);
  }

  closeSession() {
    this.chatPanelRef()?.clearMessages();
    this.activeSession.set(null);
    this.latestFailure.set(null);
  }

  confirmArchiveSession() {
    const session = this.activeSession();
    if (!session) return;

    this.api.archiveSession(session.id).subscribe({
      next: (result) => {
        if (result.success) {
          const p = this.project();
          if (p) this.loadSessions(p.id);
          this.closeSession();
        } else if (result.error) {
          console.error('Archive failed:', result.error);
          const p = this.project();
          if (p) this.loadSessions(p.id);
        }
      },
      error: (err) => {
        console.error('Archive request failed:', err);
      },
    });
  }

  createDevSession(data: { title: string; branch?: string }) {
    const p = this.project();
    if (!p) return;

    this.api.createDevSession({
      projectId: p.id,
      title: data.title,
      branch: data.branch || undefined,
    }).subscribe({
      next: (session) => {
        this.sessions.update(s => [session, ...s]);
        this.openSession(session);
      },
      error: (err) => {
        console.error('Failed to create dev session:', err);
      },
    });
  }

  // ─── Pipeline ────────────────────────────────────────────

  resumePipelineFromFailure() {
    const p = this.project();
    const session = this.activeSession();
    const failure = this.latestFailure();
    if (!p || !session || !failure || this.resumingFailure()) return;

    this.resumingFailure.set(true);
    this.api.resumePipeline({
      projectId: p.id,
      chatSessionId: session.id,
      failedTaskId: failure.taskId,
    }).subscribe({
      next: () => {
        this.resumingFailure.set(false);
        this.refreshLatestFailure(session.id);
        this.loadIssues(p.id);
        this.loadMilestones(p.id);
      },
      error: () => {
        this.resumingFailure.set(false);
      },
    });
  }

  // ─── Settings ────────────────────────────────────────────

  populateSettingsForm(p: Project) {
    this.settingsName = p.name;
    this.settingsDescription = p.description ?? '';
    this.settingsWorkBranch = p.workBranch ?? '';
    this.settingsMaxFixAttempts = (p as any).maxFixAttempts ?? null;
    this.settingsStatus = p.status ?? 'READY';

    const ts = p.techStack as Record<string, unknown> | null;
    if (ts) {
      const stack = ts['techStack'] as Record<string, unknown> | undefined;
      if (stack) {
        this.settingsFramework = String(stack['framework'] ?? '');
        this.settingsLanguage = String(stack['language'] ?? '');
        this.settingsBackend = String(stack['backend'] ?? '');
        this.settingsDatabase = String(stack['database'] ?? '');
        const additional = stack['additional'];
        this.settingsAdditional = Array.isArray(additional) ? additional.join(', ') : '';
      }

      const deploy = ts['deployment'] as Record<string, unknown> | undefined;
      if (deploy) {
        this.settingsIsWeb = Boolean(deploy['isWebProject']);
        this.settingsDevPort = deploy['devServerPort'] as number ?? null;
        this.settingsDevCmd = String(deploy['devServerCommand'] ?? '');
        this.settingsBuildCmd = String(deploy['buildCommand'] ?? '');
      }

      const setup = ts['setupInstructions'] as Record<string, unknown> | undefined;
      if (setup) {
        this.settingsInitCmd = String(setup['initCommand'] ?? '');
        const cmds = setup['additionalCommands'];
        this.settingsAdditionalCmds = Array.isArray(cmds) ? cmds.join('\n') : '';
      }
    }
  }

  saveProjectSettings() {
    const p = this.project();
    if (!p) return;

    this.saving.set(true);
    this.toast.set(null);

    const additionalPkgs = this.settingsAdditional
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const additionalCmds = this.settingsAdditionalCmds
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);

    this.api.updateProject(p.id, {
      name: this.settingsName,
      description: this.settingsDescription || undefined,
      workBranch: this.settingsWorkBranch || null,
      maxFixAttempts: this.settingsMaxFixAttempts || null,
      status: this.settingsStatus,
      techStack: {
        techStack: {
          framework: this.settingsFramework || undefined,
          language: this.settingsLanguage || undefined,
          backend: this.settingsBackend || undefined,
          database: this.settingsDatabase || undefined,
          additional: additionalPkgs.length > 0 ? additionalPkgs : undefined,
        },
        deployment: {
          isWebProject: this.settingsIsWeb,
          devServerPort: this.settingsDevPort ?? undefined,
          devServerCommand: this.settingsDevCmd || undefined,
          buildCommand: this.settingsBuildCmd || undefined,
        },
        setupInstructions: {
          initCommand: this.settingsInitCmd || undefined,
          additionalCommands: additionalCmds.length > 0 ? additionalCmds : undefined,
        },
      },
    }).subscribe({
      next: (updated) => {
        this.project.set(updated);
        this.saving.set(false);
        this.toast.set('success');
        setTimeout(() => this.toast.set(null), 3000);
      },
      error: () => {
        this.saving.set(false);
        this.toast.set('error');
        setTimeout(() => this.toast.set(null), 3000);
      },
    });
  }

  // ─── MCP Overrides ──────────────────────────────────────

  loadMcpData(projectId: string) {
    this.api.getMcpServers().subscribe((servers) => this.mcpServers.set(servers));
    this.api.getMcpProjectOverrides(projectId).subscribe((overrides) => this.mcpOverrides.set(overrides));
  }

  getOverrideState(serverId: string, role: string): 'inherit' | 'enable' | 'disable' {
    const override = this.mcpOverrides().find(
      (o) => o.mcpServerId === serverId && o.agentRole === role,
    );
    if (!override) return 'inherit';
    return override.action === 'ENABLE' ? 'enable' : 'disable';
  }

  isGloballyAssigned(serverId: string, role: string): boolean {
    const server = this.mcpServers().find((s) => s.id === serverId);
    return server?.roles.includes(role) ?? false;
  }

  cycleOverride(serverId: string, role: string) {
    const p = this.project();
    if (!p) return;

    const current = this.getOverrideState(serverId, role);
    if (current === 'inherit') {
      this.api.setMcpProjectOverride(p.id, { mcpServerId: serverId, agentRole: role, action: 'ENABLE' }).subscribe(() => this.loadMcpData(p.id));
    } else if (current === 'enable') {
      this.api.setMcpProjectOverride(p.id, { mcpServerId: serverId, agentRole: role, action: 'DISABLE' }).subscribe(() => this.loadMcpData(p.id));
    } else {
      this.api.deleteMcpProjectOverride(p.id, { mcpServerId: serverId, agentRole: role }).subscribe(() => this.loadMcpData(p.id));
    }
  }

  // ─── Data Loading ────────────────────────────────────────

  loadIssues(projectId: string) {
    this.api.getIssues(projectId).subscribe((issues) => this.issues.set(issues));
  }

  loadMilestones(projectId: string) {
    this.api.getMilestones(projectId).subscribe((milestones) => {
      this.milestones.set(milestones);
    });
  }

  loadSessions(projectId: string) {
    this.api.getChatSessions(projectId).subscribe((sessions) =>
      this.sessions.set(sessions),
    );
  }

  // ─── Helpers ─────────────────────────────────────────────

  formatDate(dateStr: string): string {
    return new Date(dateStr).toLocaleDateString(this.i18n.dateLocale, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  private refreshLatestFailure(chatSessionId: string) {
    const p = this.project();
    if (!p) return;
    this.api.getLatestPipelineFailure(p.id, chatSessionId).subscribe({
      next: (failure) => this.latestFailure.set(failure),
      error: () => this.latestFailure.set(null),
    });
  }
}
