import {
  Component,
  inject,
  OnInit,
  OnDestroy,
  signal,
  viewChild,
  ElementRef,
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
  IssueComment,
  Milestone,
  ChatSession,
  ChatSessionType,
  SessionStatus,
  ChatMessage,
  McpServerDefinition,
  McpProjectOverride,
} from '../../services/api.service';
import { ChatSocketService } from '../../services/chat-socket.service';
import { VoiceService } from '../../services/voice.service';
import { IconComponent } from '../../components/icon.component';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { TranslateService } from '../../services/translate.service';

/** Agent role config — icon, color, i18n key */
const AGENT_CONFIG: Record<string, { icon: string; color: string; labelKey: string }> = {
  INTERVIEWER:       { icon: 'message-circle', color: 'sky', labelKey: 'agents.interviewer' },
  ARCHITECT:         { icon: 'pen-tool', color: 'violet', labelKey: 'agents.architect' },
  ISSUE_COMPILER:    { icon: 'list-checks', color: 'amber', labelKey: 'agents.issueCompiler' },
  CODER:             { icon: 'code-2', color: 'indigo', labelKey: 'agents.developer' },
  CODE_REVIEWER:     { icon: 'search-check', color: 'emerald', labelKey: 'agents.reviewer' },
  UI_TESTER:         { icon: 'monitor-check', color: 'pink', labelKey: 'agents.uiTester' },
  FUNCTIONAL_TESTER: { icon: 'test-tubes', color: 'teal', labelKey: 'agents.functionalTester' },
  PEN_TESTER:        { icon: 'shield-alert', color: 'red', labelKey: 'agents.pentester' },
  DOCUMENTER:        { icon: 'file-text', color: 'cyan', labelKey: 'agents.docs' },
  DEVOPS:            { icon: 'rocket', color: 'orange', labelKey: 'agents.devops' },
};

/** Issue status steps for progress dots */
const ISSUE_STEPS = ['OPEN', 'IN_PROGRESS', 'IN_REVIEW', 'TESTING', 'DONE', 'CLOSED'];

const PROJECT_STATUSES: ProjectStatus[] = ['INTERVIEWING', 'SETTING_UP', 'READY', 'ARCHIVED'];

type Tab = 'overview' | 'settings';

@Component({
  selector: 'app-project',
  imports: [FormsModule, RouterLink, IconComponent, TranslatePipe],
  styles: [`
    .animate-slide-in-right {
      animation: slideInRight 0.25s ease-out;
    }
    @keyframes slideInRight {
      from { transform: translateX(100%); }
      to { transform: translateX(0); }
    }
  `],
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

      <!-- ═══ TAB: Overview ═══ -->
      @if (activeTab() === 'overview') {
        <!-- Agent Pipeline -->
        <div class="glass card-glow rounded-[2rem] p-6 mb-6 relative overflow-hidden animate-in stagger-4">
          <div class="flex items-center justify-between mb-4">
            <h2 class="text-sm font-bold text-slate-500 uppercase tracking-widest">{{ 'project.agentPipeline' | translate }}</h2>
            @if (hasWorkingAgent()) {
              <span class="text-[10px] text-indigo-400 font-mono animate-pulse uppercase tracking-widest shrink-0">{{ 'project.processing' | translate }}</span>
            }
          </div>

          <div class="relative overflow-x-auto pb-2">
            <div class="relative flex items-center gap-3 min-w-max">
              <!-- Connection Line -->
              <div class="absolute top-1/2 left-0 w-full h-[2px] bg-slate-800 -translate-y-1/2 z-0"></div>
              @if (hasWorkingAgent()) {
                <div class="absolute top-1/2 left-0 w-full h-[2px] -translate-y-1/2 z-0 pulse-line"></div>
              }

              <!-- Agent Cards -->
              @for (entry of agentEntries(); track entry.role) {
                <div
                  class="w-[130px] shrink-0 glass p-3 rounded-2xl z-10 transition-all duration-500 border border-transparent"
                  [class]="entry.instance?.status === 'WORKING' ? 'agent-glow-' + entry.color + ' -translate-y-1' : 'opacity-50'"
                >
                  <div class="flex items-center gap-2 mb-1.5">
                    <div
                      class="p-2 rounded-xl shrink-0"
                      [class]="'bg-' + entry.color + '-500/20 text-' + entry.color + '-400'"
                    >
                      @if (entry.instance?.status === 'WORKING') {
                        <div class="activity-ring">
                          <app-icon [name]="entry.icon" [size]="16" />
                        </div>
                      } @else {
                        <app-icon [name]="entry.icon" [size]="16" />
                      }
                    </div>
                    <span class="font-semibold text-xs text-white truncate" [title]="entry.labelKey | translate">{{ entry.labelKey | translate }}</span>
                  </div>
                  <p class="text-[10px] text-slate-600 font-mono mb-1.5 truncate"
                     [title]="(entry.instance?.provider ?? '') + (entry.instance?.model ? ' · ' + entry.instance!.model : '')">
                    {{ entry.instance?.provider ?? ('project.notAssigned' | translate) }}
                    @if (entry.instance?.model) {
                      · {{ entry.instance!.model }}
                    }
                  </p>
                  @if (entry.instance?.status === 'WORKING') {
                    <span class="text-[10px] font-mono animate-pulse uppercase tracking-widest"
                      [class]="'text-' + entry.color + '-400'"
                    >
                      {{ 'project.working' | translate }}
                    </span>
                  } @else if (entry.instance) {
                    <span class="text-[10px] text-slate-600 font-mono uppercase">{{ entry.instance.status }}</span>
                  }
                </div>
              }
            </div>
          </div>
        </div>

        <!-- Main Content: Issues + Chat/Terminal -->
        <div class="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4">

          <!-- Left: Issues (grouped by milestones) -->
          <div class="glass rounded-3xl p-5 max-h-[65vh] overflow-y-auto animate-in stagger-5">
            <div class="flex items-center justify-between mb-4">
              <h3 class="text-sm font-bold text-slate-500 uppercase tracking-widest">{{ 'project.issues' | translate }}</h3>
              <span class="text-[10px] font-mono text-slate-600">{{ issues().length }}</span>
            </div>

            @if (issuesByMilestone().length > 0) {
              @for (group of issuesByMilestone(); track group.id) {
                <!-- Milestone Header -->
                <button
                  class="w-full flex items-center justify-between gap-2 px-3 py-2 mb-1 rounded-xl bg-amber-500/10 border border-amber-500/20 hover:bg-amber-500/15 transition-all cursor-pointer"
                  (click)="toggleMilestone(group.id)"
                >
                  <div class="flex items-center gap-2 min-w-0">
                    <app-icon
                      [name]="isMilestoneExpanded(group.id) ? 'chevron-down' : 'chevron-right'"
                      [size]="14"
                      class="text-amber-400 shrink-0"
                    />
                    <span class="text-xs font-bold text-amber-400 uppercase tracking-widest truncate">{{ group.title }}</span>
                  </div>
                  <span class="text-[10px] font-mono text-amber-500/60 shrink-0">
                    {{ i18n.t('project.milestoneIssues', { count: group.issues.length }) }}
                  </span>
                </button>

                <!-- Issues within milestone -->
                @if (isMilestoneExpanded(group.id)) {
                  @for (issue of group.issues; track issue.id) {
                    <div
                      class="bg-black/30 rounded-xl p-3 mb-2 ml-2 border-l-2 transition-all hover:bg-black/40 cursor-pointer"
                      [class]="issueBorderClass(issue.priority)"
                      (click)="openIssueDetail(issue)"
                    >
                      <div class="flex items-center justify-between mb-1">
                        <span class="text-[10px] uppercase tracking-widest font-bold"
                          [class]="issuePriorityColor(issue.priority)"
                        >
                          {{ issue.priority }}
                        </span>
                        <span class="text-[9px] font-mono text-slate-600 uppercase">{{ issue.status }}</span>
                      </div>
                      <p class="text-sm text-slate-300 mb-2">{{ issue.title }}</p>
                      <div class="progress-dots">
                        @for (step of issueSteps; track step; let i = $index) {
                          <span
                            class="dot"
                            [class.done]="getStepIndex(issue.status) > i"
                            [class.active]="getStepIndex(issue.status) === i"
                          ></span>
                        }
                      </div>
                      @if (issue.subIssues && issue.subIssues.length > 0) {
                        <span class="text-[10px] mt-1 block"
                          [class]="getSubIssueDoneCount(issue.subIssues) === issue.subIssues.length ? 'text-emerald-500/60' : 'text-slate-600'">
                          {{ getSubIssueDoneCount(issue.subIssues) }}/{{ issue.subIssues.length }} {{ 'project.subIssuesTasks' | translate }}
                        </span>
                      }
                    </div>
                  }
                }
              }
            } @else if (issues().length > 0) {
              <!-- Fallback: no milestones, show flat list -->
              @for (issue of issues(); track issue.id) {
                <div
                  class="bg-black/30 rounded-xl p-3 mb-2 border-l-2 transition-all hover:bg-black/40 cursor-pointer"
                  [class]="issueBorderClass(issue.priority)"
                  (click)="openIssueDetail(issue)"
                >
                  <div class="flex items-center justify-between mb-1">
                    <span class="text-[10px] uppercase tracking-widest font-bold"
                      [class]="issuePriorityColor(issue.priority)"
                    >
                      {{ issue.priority }}
                    </span>
                    <span class="text-[9px] font-mono text-slate-600 uppercase">{{ issue.status }}</span>
                  </div>
                  <p class="text-sm text-slate-300 mb-2">{{ issue.title }}</p>
                  <div class="progress-dots">
                    @for (step of issueSteps; track step; let i = $index) {
                      <span
                        class="dot"
                        [class.done]="getStepIndex(issue.status) > i"
                        [class.active]="getStepIndex(issue.status) === i"
                      ></span>
                    }
                  </div>
                  @if (issue.subIssues && issue.subIssues.length > 0) {
                    <span class="text-[10px] mt-1 block"
                      [class]="getSubIssueDoneCount(issue.subIssues) === issue.subIssues.length ? 'text-emerald-500/60' : 'text-slate-600'">
                      {{ getSubIssueDoneCount(issue.subIssues) }}/{{ issue.subIssues.length }} {{ 'project.subIssuesTasks' | translate }}
                    </span>
                  }
                </div>
              }
            } @else {
              <p class="text-slate-600 text-sm text-center py-8">{{ 'project.noIssues' | translate }}</p>
            }
          </div>

          <!-- Right: Chat Terminal -->
          <div class="glass card-glow rounded-3xl flex flex-col max-h-[65vh] animate-in stagger-6">
            <!-- Session bar -->
            <div class="flex items-center justify-between px-5 py-3 border-b border-white/5">
              <div class="flex items-center gap-3 min-w-0">
                <div class="terminal-dots shrink-0">
                  <span></span><span></span><span></span>
                </div>
                @if (activeSession()) {
                  <div class="flex items-center gap-2 min-w-0">
                    @if (activeSession()!.type === 'DEV_SESSION') {
                      <span class="shrink-0 w-2 h-2 rounded-full" [class]="sessionStatusColor(activeSession()!.status)"></span>
                    } @else {
                      <app-icon name="hard-hat" [size]="12" class="text-amber-400 shrink-0" />
                    }
                    <span class="text-[10px] font-mono text-slate-500 uppercase tracking-widest truncate">
                      {{ activeSession()!.title }}
                    </span>
                    @if (activeSession()!.branch) {
                      <span class="text-[9px] font-mono text-slate-700 truncate hidden sm:inline">{{ activeSession()!.branch }}</span>
                    }
                  </div>
                } @else {
                  <span class="text-[10px] font-mono text-slate-500 uppercase tracking-widest">
                    {{ 'project.liveSystemFeed' | translate }}
                  </span>
                }
              </div>
              <div class="flex items-center gap-2 shrink-0">
                @if (activeSession()?.type === 'DEV_SESSION' && activeSession()?.status === 'ACTIVE') {
                  <button
                    (click)="archiveCurrentSession()"
                    class="text-slate-600 hover:text-amber-400 transition-colors"
                    [title]="'session.archiveConfirm' | translate"
                  >
                    <app-icon name="archive" [size]="14" />
                  </button>
                }
                @if (activeSession()) {
                  <button
                    (click)="closeSession()"
                    class="text-slate-600 hover:text-slate-400 transition-colors"
                    [title]="'project.closeSession' | translate"
                  >
                    <app-icon name="x" [size]="14" />
                  </button>
                }
              </div>
            </div>

            @if (activeSession()) {
              <!-- Live Requirement Card (during interview) -->
              @if (interviewProgress()) {
                <div class="mx-5 mt-3 mb-1 rounded-xl bg-black/30 border border-white/5 p-3 text-xs space-y-2">
                  <div class="flex items-center justify-between">
                    <span class="text-slate-400 font-mono uppercase tracking-wider text-[10px]">Requirements</span>
                    @if (interviewProgress()!.setupReady) {
                      <span class="px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-[10px]">Ready</span>
                    } @else {
                      <span class="px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20 text-[10px]">Gathering...</span>
                    }
                  </div>
                  <div class="grid grid-cols-2 gap-x-4 gap-y-1 text-slate-500">
                    <div>Framework: <span class="text-slate-300">{{ interviewProgress()!.framework ?? '—' }}</span></div>
                    <div>Language: <span class="text-slate-300">{{ interviewProgress()!.language ?? '—' }}</span></div>
                    <div>Backend: <span class="text-slate-300">{{ interviewProgress()!.backend ?? '—' }}</span></div>
                    <div>Database: <span class="text-slate-300">{{ interviewProgress()!.database ?? '—' }}</span></div>
                  </div>
                  @if (interviewProgress()!.features && interviewProgress()!.features!.length > 0) {
                    <div class="flex flex-wrap gap-1.5 pt-1">
                      @for (f of interviewProgress()!.features!; track f.title) {
                        <span class="px-2 py-0.5 rounded-full text-[10px] font-medium border"
                          [class]="f.priority === 'must-have'
                            ? 'bg-rose-500/10 text-rose-400 border-rose-500/20'
                            : f.priority === 'nice-to-have'
                              ? 'bg-sky-500/10 text-sky-400 border-sky-500/20'
                              : 'bg-amber-500/10 text-amber-400 border-amber-500/20'">
                          {{ f.title }}
                        </span>
                      }
                    </div>
                  }
                </div>
              }

              <!-- Messages -->
              <div class="flex-1 overflow-y-auto p-5 font-mono text-sm space-y-1.5" #messageContainer>
                @for (msg of messages(); track msg.id) {
                  <div class="flex gap-2">
                    <span class="text-slate-700 shrink-0">[{{ formatTime(msg.createdAt) }}]</span>
                    @switch (msg.role) {
                      @case ('USER') {
                        <span class="text-white"><span class="text-indigo-500">></span> {{ msg.content }}</span>
                      }
                      @case ('ASSISTANT') {
                        <span class="text-indigo-400">{{ msg.content }}</span>
                      }
                      @case ('AGENT') {
                        <span class="text-emerald-400">{{ msg.content }}</span>
                      }
                      @case ('SYSTEM') {
                        <span class="text-slate-500 italic">{{ msg.content }}</span>
                      }
                    }
                  </div>
                }
                @if (messages().length === 0 && !isStreaming()) {
                  <p class="text-indigo-500">> {{ 'project.systemReady' | translate }}</p>
                }
                @if (isStreaming() && streamingContent()) {
                  <div class="flex gap-2">
                    <span class="text-slate-700 shrink-0">[...]</span>
                    <span class="text-emerald-400">{{ streamingContent() }}<span class="animate-pulse">▊</span></span>
                  </div>
                }
                @if (hasWorkingAgent() && !isStreaming()) {
                  <div class="flex items-center gap-2 text-emerald-400/60">
                    <span class="inline-flex gap-1">
                      <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-bounce" style="animation-delay: 0ms"></span>
                      <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-bounce" style="animation-delay: 150ms"></span>
                      <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-bounce" style="animation-delay: 300ms"></span>
                    </span>
                    <span class="text-xs">{{ 'project.agentThinking' | translate }}</span>
                  </div>
                }
              </div>

              <!-- Suggestion Chips -->
              @if (suggestions().length > 0) {
                <div class="px-5 py-2 border-t border-white/5 flex flex-wrap gap-2">
                  @for (s of suggestions(); track s) {
                    <button
                      (click)="useSuggestion(s)"
                      class="px-3 py-1 rounded-full bg-indigo-500/10 text-indigo-400 text-xs font-medium border border-indigo-500/20 hover:bg-indigo-500/20 hover:border-indigo-500/40 transition-all cursor-pointer"
                    >
                      {{ s }}
                    </button>
                  }
                </div>
              }

              <!-- TTS Speaking Indicator -->
              @if (voice.isSpeaking()) {
                <div class="px-5 py-1.5 border-t border-white/5 flex items-center gap-2">
                  <div class="flex items-center gap-1 h-4">
                    <span class="w-0.5 h-2 bg-sky-400 rounded-full animate-pulse"></span>
                    <span class="w-0.5 h-3 bg-sky-400 rounded-full animate-pulse" style="animation-delay: 0.15s"></span>
                    <span class="w-0.5 h-2 bg-sky-400 rounded-full animate-pulse" style="animation-delay: 0.3s"></span>
                  </div>
                  <span class="text-sky-400 text-xs font-mono">{{ 'voice.speaking' | translate }}</span>
                  <button
                    (click)="voice.stopPlayback()"
                    class="text-slate-600 hover:text-red-400 transition-colors ml-auto"
                  >
                    <app-icon name="square" [size]="12" />
                  </button>
                </div>
              }

              <!-- Recording Overlay -->
              @if (voice.isRecording()) {
                <div class="px-5 py-2 border-t border-white/5 flex items-center gap-3 bg-red-500/5">
                  <span class="w-3 h-3 rounded-full bg-red-500 animate-pulse shrink-0"></span>
                  <span class="text-red-400 text-xs font-mono flex-1 truncate">
                    {{ voice.transcript() || ('voice.listening' | translate) }}
                  </span>
                  <button
                    (click)="voice.stopRecording()"
                    class="text-emerald-400 hover:text-emerald-300 transition-colors shrink-0"
                    [title]="'voice.stopRecording' | translate"
                  >
                    <app-icon name="send-horizontal" [size]="16" />
                  </button>
                  <button
                    (click)="voice.cancelRecording()"
                    class="text-slate-600 hover:text-red-400 transition-colors shrink-0"
                  >
                    <app-icon name="x" [size]="14" />
                  </button>
                </div>
              }

              <!-- Input -->
              <div class="px-5 py-3 border-t border-white/5">
                <div class="flex items-center gap-2 bg-black/40 rounded-xl px-4 py-2.5">
                  <span class="text-indigo-500 font-mono text-sm shrink-0">></span>
                  <input
                    type="text"
                    [(ngModel)]="messageInput"
                    (keydown.enter)="sendMessage()"
                    [placeholder]="'project.chatPlaceholder' | translate"
                    class="flex-1 bg-transparent border-none outline-none text-white font-mono text-sm placeholder-slate-600"
                  />
                  <input
                    type="file"
                    #fileInput
                    (change)="onFileSelected($event)"
                    accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,.md"
                    class="hidden"
                  />
                  <button
                    (click)="fileInput.click()"
                    class="text-slate-600 hover:text-amber-400 transition-colors shrink-0"
                    title="Upload PDF, image, or text file"
                  >
                    <app-icon name="paperclip" [size]="16" />
                  </button>
                  @if (voice.voiceSupported()) {
                    <button
                      (click)="onMicClick()"
                      class="transition-colors shrink-0"
                      [class]="voice.isVoiceMode() ? 'text-red-400 hover:text-red-300' : 'text-slate-600 hover:text-sky-400'"
                      [title]="(voice.isVoiceMode() ? 'voice.stopRecording' : 'voice.startRecording') | translate"
                    >
                      <app-icon [name]="voice.isVoiceMode() ? 'mic-off' : 'mic'" [size]="16" />
                    </button>
                  }
                  <button
                    (click)="sendMessage()"
                    class="text-slate-600 hover:text-indigo-400 transition-colors shrink-0"
                  >
                    <app-icon name="send-horizontal" [size]="16" />
                  </button>
                </div>
              </div>
            } @else {
              <!-- Session Navigator (3 sections) -->
              <div class="flex-1 overflow-y-auto p-4 space-y-4">

                <!-- Section 1: Infrastructure -->
                <div>
                  <div class="flex items-center gap-2 mb-2">
                    <app-icon name="hard-hat" [size]="14" class="text-amber-400" />
                    <span class="text-[10px] font-bold text-slate-500 uppercase tracking-widest">{{ 'session.infrastructure' | translate }}</span>
                  </div>
                  @if (infraSession()) {
                    <div
                      class="flex items-center justify-between bg-black/30 rounded-xl p-3 cursor-pointer hover:bg-black/40 transition-colors border border-amber-500/10"
                      (click)="openSession(infraSession()!)"
                    >
                      <div class="flex items-center gap-3 min-w-0">
                        <span class="w-2 h-2 rounded-full bg-amber-400 shrink-0"></span>
                        <span class="text-sm text-slate-300 truncate">{{ infraSession()!.title }}</span>
                      </div>
                      <span class="text-[10px] font-mono text-slate-600 shrink-0">{{ formatTime(infraSession()!.updatedAt) }}</span>
                    </div>
                  } @else {
                    <p class="text-slate-700 text-xs px-3">{{ 'project.startNewChat' | translate }}</p>
                  }
                </div>

                <!-- Section 2: Dev Sessions -->
                <div>
                  <div class="flex items-center justify-between mb-2">
                    <div class="flex items-center gap-2">
                      <app-icon name="git-branch" [size]="14" class="text-indigo-400" />
                      <span class="text-[10px] font-bold text-slate-500 uppercase tracking-widest">{{ 'session.devSessions' | translate }}</span>
                    </div>
                    <button
                      (click)="showNewSessionModal.set(true)"
                      class="text-slate-600 hover:text-indigo-400 transition-colors"
                      [title]="'session.new' | translate"
                    >
                      <app-icon name="plus" [size]="14" />
                    </button>
                  </div>
                  @for (s of devSessions(); track s.id) {
                    <div
                      class="flex items-center justify-between bg-black/30 rounded-xl p-3 mb-2 cursor-pointer hover:bg-black/40 transition-colors"
                      (click)="openSession(s)"
                    >
                      <div class="flex items-center gap-3 min-w-0 flex-1">
                        <span class="w-2 h-2 rounded-full shrink-0" [class]="sessionStatusColor(s.status)"></span>
                        <div class="min-w-0 flex-1">
                          <span class="text-sm text-slate-300 block truncate">{{ s.title }}</span>
                          <span class="text-[9px] font-mono text-slate-700 block truncate">{{ s.branch }}</span>
                        </div>
                      </div>
                      <div class="text-right shrink-0 ml-2">
                        <span class="text-[10px] font-mono text-slate-600 block">{{ formatTime(s.updatedAt) }}</span>
                        @if (s._count && s._count.issues) {
                          <span class="text-[9px] text-slate-700">{{ s._count!.issues }} issues</span>
                        }
                      </div>
                    </div>
                  }
                  @if (devSessions().length === 0) {
                    <p class="text-slate-700 text-xs px-3">{{ 'session.noSessions' | translate }}</p>
                  }
                </div>

                <!-- Section 3: Archive -->
                @if (archivedSessions().length > 0) {
                  <div>
                    <button
                      (click)="showArchive.set(!showArchive())"
                      class="flex items-center gap-2 mb-2 w-full text-left"
                    >
                      <app-icon name="archive" [size]="14" class="text-slate-600" />
                      <span class="text-[10px] font-bold text-slate-600 uppercase tracking-widest">{{ 'session.archive' | translate }}</span>
                      <app-icon [name]="showArchive() ? 'chevron-down' : 'chevron-right'" [size]="12" class="text-slate-700" />
                    </button>
                    @if (showArchive()) {
                      @for (s of archivedSessions(); track s.id) {
                        <div
                          class="flex items-center justify-between bg-black/20 rounded-xl p-3 mb-2 cursor-pointer hover:bg-black/30 transition-colors opacity-60"
                          (click)="openSession(s)"
                        >
                          <div class="flex items-center gap-3 min-w-0">
                            <app-icon name="archive" [size]="12" class="text-slate-700 shrink-0" />
                            <span class="text-sm text-slate-500 truncate">{{ s.title }}</span>
                          </div>
                          <span class="text-[10px] font-mono text-slate-700 shrink-0">{{ formatDate(s.archivedAt || s.updatedAt) }}</span>
                        </div>
                      }
                    }
                  </div>
                }
              </div>
            }
          </div>
        </div>
      }

      <!-- ═══ TAB: Settings ═══ -->
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
                <input type="text" [value]="p.previewPort ?? '—'" disabled class="w-full bg-black/20 rounded-xl px-4 py-2.5 text-sm text-slate-500 border border-white/5 cursor-not-allowed" />
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
                <input type="text" [value]="p.gitlabUrl ?? '—'" disabled class="w-full bg-black/20 rounded-xl px-4 py-2.5 text-sm text-slate-500 border border-white/5 cursor-not-allowed font-mono" />
              </div>
              <div>
                <label class="block text-xs text-slate-500 mb-1">{{ 'project.settings.gitlabProjectId' | translate }}</label>
                <input type="text" [value]="p.gitlabProjectId ?? '—'" disabled class="w-full bg-black/20 rounded-xl px-4 py-2.5 text-sm text-slate-500 border border-white/5 cursor-not-allowed font-mono" />
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
                                ·
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
      <!-- ═══ Issue Detail Slide-Over ═══ -->
      @if (selectedIssue(); as si) {
        <div class="fixed inset-0 z-50 flex justify-end" (click)="closeIssueDetail()">
          <div class="absolute inset-0 bg-black/60 backdrop-blur-sm"></div>
          <div
            class="relative w-full max-w-lg bg-slate-900/95 border-l border-white/10 shadow-2xl overflow-y-auto animate-slide-in-right"
            (click)="$event.stopPropagation()"
          >
            <!-- Header -->
            <div class="sticky top-0 z-10 bg-slate-900/95 border-b border-white/5 px-6 py-4">
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-3">
                  <span class="text-[10px] uppercase tracking-widest font-bold"
                    [class]="issuePriorityColor(si.priority)">
                    {{ si.priority }}
                  </span>
                  @if (si.gitlabIid) {
                    <span class="text-xs font-mono text-slate-500">#{{ si.gitlabIid }}</span>
                  }
                  <span class="text-[9px] font-mono text-slate-600 uppercase px-2 py-0.5 rounded-full border border-white/5">
                    {{ si.status }}
                  </span>
                </div>
                <button (click)="closeIssueDetail()" class="text-slate-500 hover:text-white transition-colors">
                  <app-icon name="x" [size]="18" />
                </button>
              </div>
              <h2 class="text-lg font-bold text-white mt-2">{{ si.title }}</h2>
            </div>

            <div class="px-6 py-4 space-y-6">
              <!-- Description -->
              @if (si.description) {
                <div>
                  <h3 class="text-xs font-bold text-slate-500 uppercase tracking-widest mb-2">{{ 'project.issueDetail' | translate }}</h3>
                  <p class="text-sm text-slate-300 whitespace-pre-wrap">{{ si.description }}</p>
                </div>
              }

              <!-- Sub-Issues -->
              @if (si.subIssues && si.subIssues.length > 0) {
                <div>
                  <div class="flex items-center justify-between mb-2">
                    <h3 class="text-xs font-bold text-slate-500 uppercase tracking-widest">
                      {{ i18n.t('project.subIssues', { count: si.subIssues.length }) }}
                    </h3>
                    <span class="text-[10px] font-mono text-slate-600">
                      {{ getSubIssueDoneCount(si.subIssues) }}/{{ si.subIssues.length }} {{ 'project.subIssuesPassed' | translate }}
                    </span>
                  </div>
                  <div class="space-y-1.5">
                    @for (sub of si.subIssues; track sub.id) {
                      <div class="flex items-center gap-2.5 text-sm"
                        [class]="sub.status === 'DONE' || sub.status === 'CLOSED' ? 'text-emerald-400' : sub.status === 'NEEDS_REVIEW' ? 'text-red-400' : 'text-slate-400'">
                        <span class="w-2 h-2 rounded-full flex-shrink-0"
                          [class]="sub.status === 'DONE' || sub.status === 'CLOSED' ? 'bg-emerald-400' :
                                   sub.status === 'NEEDS_REVIEW' ? 'bg-red-400' :
                                   sub.status === 'IN_PROGRESS' || sub.status === 'TESTING' ? 'bg-amber-400' : 'bg-slate-600'"
                        ></span>
                        <span class="flex-1">{{ sub.title }}</span>
                        @if (sub.status === 'DONE' || sub.status === 'CLOSED') {
                          <span class="text-[10px] text-emerald-500/70">✓</span>
                        } @else if (sub.status === 'NEEDS_REVIEW') {
                          <span class="text-[10px] text-red-500/70">✗</span>
                        }
                      </div>
                    }
                  </div>
                </div>
              }

              <!-- Labels -->
              @if (si.labels && si.labels.length > 0) {
                <div class="flex flex-wrap gap-1">
                  @for (label of si.labels; track label) {
                    <span class="text-[10px] px-2 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300 border border-indigo-500/20">
                      {{ label }}
                    </span>
                  }
                </div>
              }

              <!-- Progress -->
              <div class="progress-dots">
                @for (step of issueSteps; track step; let i = $index) {
                  <span
                    class="dot"
                    [class.done]="getStepIndex(si.status) > i"
                    [class.active]="getStepIndex(si.status) === i"
                  ></span>
                }
              </div>

              <!-- Comments Timeline -->
              <div>
                <h3 class="text-xs font-bold text-slate-500 uppercase tracking-widest mb-3">
                  {{ 'project.comments' | translate }}
                </h3>

                @if (selectedIssueComments().length > 0) {
                  <div class="space-y-3">
                    @for (comment of selectedIssueComments(); track comment.id) {
                      <div class="rounded-xl p-3 border"
                        [class]="comment.authorType === 'AGENT' ? 'bg-indigo-500/5 border-indigo-500/20' : comment.authorType === 'USER' ? 'bg-emerald-500/5 border-emerald-500/20' : 'bg-amber-500/5 border-amber-500/20'"
                      >
                        <div class="flex items-center justify-between mb-1">
                          <span class="text-[10px] font-bold uppercase tracking-widest"
                            [class]="comment.authorType === 'AGENT' ? 'text-indigo-400' : comment.authorType === 'USER' ? 'text-emerald-400' : 'text-amber-400'"
                          >
                            {{ comment.authorName }}
                          </span>
                          <span class="text-[9px] font-mono text-slate-600">{{ formatTime(comment.createdAt) }}</span>
                        </div>
                        <p class="text-sm text-slate-300 whitespace-pre-wrap">{{ comment.content }}</p>
                      </div>
                    }
                  </div>
                } @else {
                  <p class="text-sm text-slate-600 text-center py-4">{{ 'project.noComments' | translate }}</p>
                }

                <!-- Comment Input -->
                <div class="mt-4 flex gap-2">
                  <input
                    type="text"
                    [(ngModel)]="commentInput"
                    [placeholder]="'project.addComment' | translate"
                    class="flex-1 bg-black/40 rounded-xl px-4 py-2.5 text-sm text-white border border-white/5 outline-none focus:border-indigo-500/50 transition-colors"
                    (keydown.enter)="postComment()"
                  />
                  <button
                    (click)="postComment()"
                    [disabled]="!commentInput.trim() || commentSyncing()"
                    class="px-4 py-2.5 rounded-xl text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {{ 'common.send' | translate }}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      }

      <!-- New Session Modal -->
      @if (showNewSessionModal()) {
        <div class="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4" (click)="showNewSessionModal.set(false)">
          <div class="glass card-glow rounded-2xl p-6 w-full max-w-md border border-white/10" (click)="$event.stopPropagation()">
            <h3 class="text-lg font-bold text-white mb-4 flex items-center gap-2">
              <app-icon name="git-branch" [size]="20" class="text-indigo-400" />
              {{ 'session.newTitle' | translate }}
            </h3>
            <div class="space-y-4">
              <div>
                <label class="block text-xs text-slate-500 mb-1">{{ 'common.name' | translate }}</label>
                <input
                  type="text"
                  [(ngModel)]="newSessionTitle"
                  (ngModelChange)="autoGenerateBranch($event)"
                  class="w-full bg-black/40 rounded-xl px-4 py-2.5 text-sm text-white border border-white/5 outline-none focus:border-indigo-500/50 transition-colors"
                  placeholder="User Authentication System"
                />
              </div>
              <div>
                <label class="block text-xs text-slate-500 mb-1">{{ 'session.branch' | translate }}
                  <span class="text-slate-700">— {{ 'session.branchAutoGen' | translate }}</span>
                </label>
                <input
                  type="text"
                  [(ngModel)]="newSessionBranch"
                  class="w-full bg-black/40 rounded-xl px-4 py-2.5 text-sm text-slate-400 font-mono border border-white/5 outline-none focus:border-indigo-500/50 transition-colors"
                  placeholder="session/user-authentication-system"
                />
              </div>
            </div>
            <div class="flex justify-end gap-3 mt-6">
              <button
                (click)="showNewSessionModal.set(false)"
                class="px-4 py-2 rounded-xl text-sm text-slate-400 hover:text-white transition-colors"
              >{{ 'common.cancel' | translate }}</button>
              <button
                (click)="createDevSession()"
                class="px-5 py-2 rounded-xl text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-500 transition-colors shadow-lg shadow-indigo-500/20"
              >{{ 'common.create' | translate }}</button>
            </div>
          </div>
        </div>
      }

      <!-- Archive Confirm Modal -->
      @if (showArchiveModal()) {
        <div class="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4" (click)="showArchiveModal.set(false)">
          <div class="glass card-glow rounded-2xl p-6 w-full max-w-md border border-white/10" (click)="$event.stopPropagation()">
            <h3 class="text-lg font-bold text-white mb-2 flex items-center gap-2">
              <app-icon name="archive" [size]="20" class="text-amber-400" />
              {{ 'session.archiveConfirm' | translate }}
            </h3>
            <p class="text-sm text-slate-400 mb-4">
              "{{ activeSession()?.title }}" {{ 'session.archiveDesc' | translate }}
            </p>
            @if (activeSession()?.branch) {
              <div class="text-xs font-mono text-slate-600 mb-4">
                {{ 'session.branch' | translate }}: {{ activeSession()!.branch }}
              </div>
            }
            <div class="flex justify-end gap-3">
              <button
                (click)="showArchiveModal.set(false)"
                class="px-4 py-2 rounded-xl text-sm text-slate-400 hover:text-white transition-colors"
              >{{ 'common.cancel' | translate }}</button>
              <button
                (click)="confirmArchiveSession()"
                class="px-5 py-2 rounded-xl text-sm font-medium bg-amber-600 text-white hover:bg-amber-500 transition-colors shadow-lg shadow-amber-500/20"
              >{{ 'session.archived' | translate }}</button>
            </div>
          </div>
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
  voice = inject(VoiceService);
  i18n = inject(TranslateService);

  project = signal<Project | null>(null);
  issues = signal<Issue[]>([]);
  milestones = signal<Milestone[]>([]);
  expandedMilestones = signal<Set<string>>(new Set());
  sessions = signal<ChatSession[]>([]);
  activeSession = signal<ChatSession | null>(null);
  messages = signal<ChatMessage[]>([]);
  messageInput = '';
  issueSteps = ISSUE_STEPS;
  projectStatuses = PROJECT_STATUSES;

  // Session-based branching
  showNewSessionModal = signal(false);
  showArchiveModal = signal(false);
  showArchive = signal(false);
  newSessionTitle = '';
  newSessionBranch = '';

  /** Infrastructure session (always first, permanent) */
  infraSession = computed(() => this.sessions().find(s => s.type === 'INFRASTRUCTURE') ?? null);
  /** Active dev sessions */
  devSessions = computed(() =>
    this.sessions().filter(s => s.type === 'DEV_SESSION' && s.status !== 'ARCHIVED')
      .sort((a, b) => {
        // ACTIVE first, then MERGING, then CONFLICT
        const order: Record<string, number> = { ACTIVE: 0, MERGING: 1, CONFLICT: 2 };
        return (order[a.status] ?? 9) - (order[b.status] ?? 9);
      }),
  );
  /** Archived sessions */
  archivedSessions = computed(() =>
    this.sessions().filter(s => s.type === 'DEV_SESSION' && s.status === 'ARCHIVED'),
  );

  // Tab
  activeTab = signal<Tab>('overview');

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

  // Issue detail panel
  selectedIssue = signal<Issue | null>(null);
  selectedIssueComments = signal<IssueComment[]>([]);
  commentInput = '';
  commentSyncing = signal(false);

  // Streaming
  streamingContent = signal('');
  isStreaming = signal(false);

  // Interview suggestions + progress
  suggestions = signal<string[]>([]);
  interviewProgress = signal<{
    framework?: string;
    language?: string;
    backend?: string;
    database?: string;
    features?: { title: string; priority: string; description?: string }[];
    setupReady?: boolean;
  } | null>(null);

  saving = signal(false);
  toast = signal<'success' | 'error' | null>(null);

  // MCP Server Overrides
  mcpServers = signal<McpServerDefinition[]>([]);
  mcpOverrides = signal<McpProjectOverride[]>([]);
  mcpRoles = Object.keys(AGENT_CONFIG);

  private messageContainer = viewChild<ElementRef>('messageContainer');
  private socketSub: Subscription | null = null;
  private agentStatusSub: Subscription | null = null;
  private projectUpdatedSub: Subscription | null = null;
  private streamStartSub: Subscription | null = null;
  private streamTokenSub: Subscription | null = null;
  private streamEndSub: Subscription | null = null;
  private suggestionsSub: Subscription | null = null;
  private progressSub: Subscription | null = null;

  /** Build agent entries from the 10 roles, filling in instance data if available */
  agentEntries = computed(() => {
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
  issuesByMilestone = computed(() => {
    const allIssues = this.issues();
    const allMilestones = this.milestones();

    const groups: { id: string; title: string; sortOrder: number; issues: Issue[] }[] = [];

    // Milestones sorted by sortOrder
    for (const ms of allMilestones) {
      groups.push({
        id: ms.id,
        title: ms.title,
        sortOrder: ms.sortOrder,
        issues: allIssues.filter(i => i.milestoneId === ms.id),
      });
    }

    // Ungrouped issues (no milestone)
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
    effect(() => {
      this.messages();
      this.hasWorkingAgent();
      setTimeout(() => this.scrollToBottom(), 50);
    });

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

    this.socketSub = this.chatSocket.newMessage$.subscribe((msg) => {
      this.messages.update((msgs) => [...msgs, msg]);
    });

    // Listen for agent status changes to update pipeline visualization
    this.agentStatusSub = this.chatSocket.agentStatus$.subscribe((event) => {
      const p = this.project();
      if (p && event.projectId === p.id) {
        // Reload project to get updated agent statuses
        this.api.getProject(p.slug).subscribe((updated) => {
          this.project.set(updated);
        });

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

    // Streaming: accumulate tokens into a live preview
    this.streamStartSub = this.chatSocket.streamStart$.subscribe(() => {
      this.streamingContent.set('');
      this.isStreaming.set(true);
    });

    this.streamTokenSub = this.chatSocket.streamToken$.subscribe((event) => {
      this.streamingContent.update((c) => c + event.token);
      setTimeout(() => this.scrollToBottom(), 20);
    });

    this.streamEndSub = this.chatSocket.streamEnd$.subscribe(() => {
      this.streamingContent.set('');
      this.isStreaming.set(false);
    });

    this.suggestionsSub = this.chatSocket.chatSuggestions$.subscribe((event) => {
      this.suggestions.set(event.suggestions);
    });

    this.progressSub = this.chatSocket.interviewProgress$.subscribe((event) => {
      this.interviewProgress.set(event.progress);
    });
  }

  ngOnDestroy() {
    this.chatSocket.leaveSession();
    this.voice.teardownSocketListeners();
    this.socketSub?.unsubscribe();
    this.agentStatusSub?.unsubscribe();
    this.projectUpdatedSub?.unsubscribe();
    this.streamStartSub?.unsubscribe();
    this.streamTokenSub?.unsubscribe();
    this.streamEndSub?.unsubscribe();
    this.suggestionsSub?.unsubscribe();
    this.progressSub?.unsubscribe();
  }

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

  // ─── MCP Overrides ─────────────────────────────────────────

  loadMcpData(projectId: string) {
    this.api.getMcpServers().subscribe((servers) => this.mcpServers.set(servers));
    this.api.getMcpProjectOverrides(projectId).subscribe((overrides) => this.mcpOverrides.set(overrides));
  }

  /** Get the override state for a server+role: 'inherit' (global default), 'enable', or 'disable' */
  getOverrideState(serverId: string, role: string): 'inherit' | 'enable' | 'disable' {
    const override = this.mcpOverrides().find(
      (o) => o.mcpServerId === serverId && o.agentRole === role,
    );
    if (!override) return 'inherit';
    return override.action === 'ENABLE' ? 'enable' : 'disable';
  }

  /** Check if server is globally assigned to this role */
  isGloballyAssigned(serverId: string, role: string): boolean {
    const server = this.mcpServers().find((s) => s.id === serverId);
    return server?.roles.includes(role) ?? false;
  }

  /** Cycle override: inherit → enable → disable → inherit */
  cycleOverride(serverId: string, role: string) {
    const p = this.project();
    if (!p) return;

    const current = this.getOverrideState(serverId, role);
    if (current === 'inherit') {
      // Set to enable (override: add server for this role)
      this.api.setMcpProjectOverride(p.id, { mcpServerId: serverId, agentRole: role, action: 'ENABLE' }).subscribe(() => this.loadMcpData(p.id));
    } else if (current === 'enable') {
      // Set to disable
      this.api.setMcpProjectOverride(p.id, { mcpServerId: serverId, agentRole: role, action: 'DISABLE' }).subscribe(() => this.loadMcpData(p.id));
    } else {
      // Remove override (back to inherit)
      this.api.deleteMcpProjectOverride(p.id, { mcpServerId: serverId, agentRole: role }).subscribe(() => this.loadMcpData(p.id));
    }
  }

  loadIssues(projectId: string) {
    this.api.getIssues(projectId).subscribe((issues) => this.issues.set(issues));
  }

  loadMilestones(projectId: string) {
    this.api.getMilestones(projectId).subscribe((milestones) => {
      this.milestones.set(milestones);
      // Default: all milestones expanded
      this.expandedMilestones.set(new Set(milestones.map(m => m.id)));
    });
  }

  toggleMilestone(id: string) {
    this.expandedMilestones.update(set => {
      const next = new Set(set);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  isMilestoneExpanded(id: string): boolean {
    return this.expandedMilestones().has(id);
  }

  loadSessions(projectId: string) {
    this.api.getChatSessions(projectId).subscribe((sessions) =>
      this.sessions.set(sessions),
    );
  }

  createSession() {
    const p = this.project();
    if (!p) return;
    this.api
      .createChatSession({ projectId: p.id, title: this.i18n.t('project.newChat') })
      .subscribe((session) => {
        this.sessions.update((s) => [session, ...s]);
        this.openSession(session);
      });
  }

  openSession(session: ChatSession) {
    this.activeSession.set(session);
    this.chatSocket.joinSession(session.id);
    this.voice.setupSocketListeners();
    this.api.getChatMessages(session.id).subscribe((msgs) => {
      this.messages.set(msgs);
    });
  }

  closeSession() {
    this.chatSocket.leaveSession();
    this.activeSession.set(null);
    this.messages.set([]);
  }

  // ─── Session-Based Branching ─────────────────────────────

  autoGenerateBranch(title: string) {
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .substring(0, 40);
    this.newSessionBranch = slug ? `session/${slug}` : '';
  }

  createDevSession() {
    const p = this.project();
    if (!p || !this.newSessionTitle.trim()) return;

    this.api.createDevSession({
      projectId: p.id,
      title: this.newSessionTitle.trim(),
      branch: this.newSessionBranch.trim() || undefined,
    }).subscribe({
      next: (session) => {
        this.sessions.update(s => [session, ...s]);
        this.showNewSessionModal.set(false);
        this.newSessionTitle = '';
        this.newSessionBranch = '';
        this.openSession(session);
      },
      error: (err) => {
        console.error('Failed to create dev session:', err);
      },
    });
  }

  archiveCurrentSession() {
    this.showArchiveModal.set(true);
  }

  confirmArchiveSession() {
    const session = this.activeSession();
    if (!session) return;

    this.showArchiveModal.set(false);
    this.api.archiveSession(session.id).subscribe({
      next: (result) => {
        if (result.success) {
          // Reload sessions to reflect archived state
          const p = this.project();
          if (p) this.loadSessions(p.id);
          this.closeSession();
        } else if (result.error) {
          console.error('Archive failed:', result.error);
          // Reload to reflect CONFLICT status
          const p = this.project();
          if (p) this.loadSessions(p.id);
        }
      },
      error: (err) => {
        console.error('Archive request failed:', err);
      },
    });
  }

  continueArchivedSession(sessionId: string) {
    this.api.continueSession(sessionId).subscribe({
      next: (newSession) => {
        const p = this.project();
        if (p) this.loadSessions(p.id);
        this.openSession(newSession);
      },
      error: (err) => {
        console.error('Continue session failed:', err);
      },
    });
  }

  sessionStatusColor(status: SessionStatus | string): string {
    switch (status) {
      case 'ACTIVE': return 'bg-emerald-400';
      case 'MERGING': return 'bg-amber-400';
      case 'CONFLICT': return 'bg-red-400';
      case 'ARCHIVED': return 'bg-slate-600';
      default: return 'bg-slate-600';
    }
  }

  sendMessage() {
    const session = this.activeSession();
    const content = this.messageInput.trim();
    if (!session || !content) return;

    this.suggestions.set([]); // Clear chips on send

    this.api
      .sendChatMessage({
        chatSessionId: session.id,
        role: 'USER',
        content,
      })
      .subscribe((msg) => {
        this.messages.update((msgs) => [...msgs, msg]);
      });

    this.messageInput = '';
  }

  useSuggestion(text: string) {
    this.messageInput = text;
    this.sendMessage();
  }

  onMicClick() {
    if (!this.voice.isVoiceMode()) {
      // Enable voice mode and start recording
      this.voice.toggleVoiceMode();
      this.voice.startRecording();
    } else if (this.voice.isRecording()) {
      // Stop current recording
      this.voice.stopRecording();
    } else {
      // Voice mode active but not recording — start new recording
      this.voice.startRecording();
    }
  }

  onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    const session = this.activeSession();
    if (!file || !session) return;

    // Size check (10 MB)
    if (file.size > 10 * 1024 * 1024) {
      alert('File too large (max 10 MB)');
      input.value = '';
      return;
    }

    this.api.uploadChatFile(session.id, file).subscribe({
      next: (msg) => {
        this.messages.update((msgs) => [...msgs, msg]);
      },
      error: (err) => {
        console.error('Upload failed:', err);
      },
    });

    input.value = ''; // Reset for re-upload
  }

  formatTime(dateStr: string): string {
    return new Date(dateStr).toLocaleTimeString(this.i18n.dateLocale, {
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  formatDate(dateStr: string): string {
    return new Date(dateStr).toLocaleDateString(this.i18n.dateLocale, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  getStepIndex(status: string): number {
    return ISSUE_STEPS.indexOf(status);
  }

  getSubIssueDoneCount(subIssues: { status: string }[]): number {
    return subIssues.filter(s => s.status === 'DONE' || s.status === 'CLOSED').length;
  }

  issueBorderClass(priority: string): string {
    switch (priority) {
      case 'CRITICAL': return 'border-l-rose-500';
      case 'HIGH': return 'border-l-amber-500';
      case 'MEDIUM': return 'border-l-yellow-500';
      case 'LOW': return 'border-l-emerald-500';
      default: return 'border-l-slate-700';
    }
  }

  issuePriorityColor(priority: string): string {
    switch (priority) {
      case 'CRITICAL': return 'text-rose-400';
      case 'HIGH': return 'text-amber-400';
      case 'MEDIUM': return 'text-yellow-400';
      case 'LOW': return 'text-emerald-400';
      default: return 'text-slate-400';
    }
  }

  // ─── Issue Detail ──────────────────────────────────────────

  openIssueDetail(issue: Issue) {
    this.selectedIssue.set(issue);
    this.selectedIssueComments.set([]);
    this.commentInput = '';

    // Load full issue with sub-issues
    this.api.getIssue(issue.id).subscribe((full) => {
      this.selectedIssue.set(full);
    });

    // Load comments
    this.api.getIssueComments(issue.id).subscribe((comments) => {
      this.selectedIssueComments.set(comments);
    });
  }

  closeIssueDetail() {
    this.selectedIssue.set(null);
    this.selectedIssueComments.set([]);
    this.commentInput = '';
  }

  postComment() {
    const issue = this.selectedIssue();
    const content = this.commentInput.trim();
    if (!issue || !content) return;

    this.commentSyncing.set(true);

    this.api.addIssueComment(issue.id, {
      content,
      syncToGitlab: true,
    }).subscribe({
      next: (comment) => {
        this.selectedIssueComments.update((c) => [...c, comment]);
        this.commentInput = '';
        this.commentSyncing.set(false);
      },
      error: () => {
        this.commentSyncing.set(false);
      },
    });
  }

  private scrollToBottom() {
    const el = this.messageContainer()?.nativeElement;
    if (el) el.scrollTop = el.scrollHeight;
  }
}
