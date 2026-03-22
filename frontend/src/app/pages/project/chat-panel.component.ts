import {
  Component,
  computed,
  inject,
  input,
  output,
  signal,
  effect,
  viewChild,
  ElementRef,
  OnInit,
  OnDestroy,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import {
  ApiService,
  ChatSession,
  ChatMessage,
  SessionStatus,
} from '../../services/api.service';
import { ChatSocketService } from '../../services/chat-socket.service';
import { VoiceService } from '../../services/voice.service';
import { IconComponent } from '../../components/icon.component';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { TranslateService } from '../../services/translate.service';

export interface InterviewProgress {
  framework?: string;
  language?: string;
  backend?: string;
  database?: string;
  features?: { title: string; priority: string; description?: string }[];
  setupReady?: boolean;
}

@Component({
  selector: 'app-chat-panel',
  imports: [FormsModule, IconComponent, TranslatePipe],
  styles: [`
    .animate-slide-in-right {
      animation: slideInRight 0.25s ease-out;
    }
    @keyframes slideInRight {
      from { transform: translateX(100%); }
      to { transform: translateX(0); }
    }
    .animate-pulse-slow {
      animation: pulseSlow 2s ease-in-out infinite;
    }
    @keyframes pulseSlow {
      0%, 100% { border-color: rgb(245 158 11 / 0.3); }
      50% { border-color: rgb(245 158 11 / 0.6); }
    }
  `],
  template: `
    <!-- Chat Terminal -->
    <div class="glass card-glow rounded-3xl flex flex-col max-h-[65vh] animate-in stagger-6 relative">
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
          @if (activeSession()) {
            <!-- Chat Tabs -->
            <div class="flex gap-1 bg-black/30 rounded-lg p-0.5">
              <button
                (click)="activeTab.set('chat')"
                class="px-3 py-1 rounded-md text-[10px] font-mono uppercase tracking-wider transition-all"
                [class]="activeTab() === 'chat'
                  ? 'bg-indigo-500/20 text-indigo-400 border border-indigo-500/30'
                  : 'text-slate-600 hover:text-slate-400'"
              >
                {{ 'chat.tabChat' | translate }}
              </button>
              <button
                (click)="activeTab.set('log')"
                class="px-3 py-1 rounded-md text-[10px] font-mono uppercase tracking-wider transition-all"
                [class]="activeTab() === 'log'
                  ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                  : 'text-slate-600 hover:text-slate-400'"
              >
                {{ 'chat.tabAgentLog' | translate }}
              </button>
            </div>
          }
          @if (activeSession()?.type === 'DEV_SESSION' && activeSession()?.status === 'ACTIVE') {
            <button
              (click)="openArchiveModal()"
              class="text-slate-600 hover:text-amber-400 transition-colors"
              [title]="'session.archiveConfirm' | translate"
            >
              <app-icon name="archive" [size]="14" />
            </button>
          }
          @if (activeSession()) {
            <button
              (click)="closeSessionClicked.emit()"
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
              <div>Framework: <span class="text-slate-300">{{ interviewProgress()!.framework ?? '---' }}</span></div>
              <div>Language: <span class="text-slate-300">{{ interviewProgress()!.language ?? '---' }}</span></div>
              <div>Backend: <span class="text-slate-300">{{ interviewProgress()!.backend ?? '---' }}</span></div>
              <div>Database: <span class="text-slate-300">{{ interviewProgress()!.database ?? '---' }}</span></div>
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
          @for (msg of filteredMessages(); track msg.id) {
            @switch (msg.role) {
              @case ('USER') {
                <!-- User message: white text, indigo prefix, clean -->
                <div class="flex gap-2 py-0.5">
                  <span class="text-slate-700 shrink-0 text-xs">[{{ formatTime(msg.createdAt) }}]</span>
                  <span class="text-white"><span class="text-indigo-500 font-bold">></span> {{ msg.content }}</span>
                </div>
              }
              @case ('SYSTEM') {
                <!-- System message: slate italic, subtle -->
                <div class="flex gap-2 py-1 px-2 rounded bg-slate-800/30 my-1">
                  <span class="text-slate-700 shrink-0 text-xs">[{{ formatTime(msg.createdAt) }}]</span>
                  <span class="text-slate-500 italic text-xs">{{ msg.content }}</span>
                </div>
              }
              @case ('AGENT') {
                @if (isClarification(msg)) {
                  <!-- CLARIFICATION: Prominent amber card with pulse -->
                  <div class="my-3 border-l-4 border-amber-500 bg-amber-500/5 backdrop-blur-sm p-3 rounded-r-lg relative overflow-hidden">
                    <div class="flex items-center gap-2 mb-2">
                      <span class="px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-widest border rounded-sm" [class]="getAgentRoleColor(msg).badge">
                        {{ getRoleBadge(msg) }}
                      </span>
                      <span class="text-amber-400 text-[10px] font-bold uppercase tracking-wider">Needs your input</span>
                      <div class="flex gap-0.5 ml-auto">
                        <span class="w-1.5 h-1.5 rounded-full bg-amber-400 animate-bounce"></span>
                        <span class="w-1.5 h-1.5 rounded-full bg-amber-400 animate-bounce" style="animation-delay: 0.15s"></span>
                        <span class="w-1.5 h-1.5 rounded-full bg-amber-400 animate-bounce" style="animation-delay: 0.3s"></span>
                      </div>
                    </div>
                    <p class="text-amber-50 text-sm leading-relaxed">{{ msg.content }}</p>
                  </div>
                } @else if (isResult(msg)) {
                  <!-- RESULT: Pass/Fail with colored header -->
                  <div class="my-2 border-l-[3px] rounded-r-lg overflow-hidden" [class]="getAgentRoleColor(msg).border">
                    <div class="flex items-center gap-2 px-3 py-1.5" [class]="getAgentRoleColor(msg).bg">
                      <span class="px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-widest border rounded-sm" [class]="getAgentRoleColor(msg).badge">
                        {{ getRoleBadge(msg) }}
                      </span>
                      <span class="text-slate-600 text-[10px]">{{ formatTime(msg.createdAt) }}</span>
                    </div>
                    <div class="px-3 py-2 text-sm" [class]="getAgentRoleColor(msg).text">{{ msg.content }}</div>
                  </div>
                } @else {
                  <!-- STANDARD agent message: left border + role badge -->
                  <div class="my-1 flex items-start gap-0 border-l-2 pl-3 py-1 hover:bg-white/[0.02] transition-colors" [class]="getAgentRoleColor(msg).border">
                    <span class="text-slate-700 shrink-0 text-xs mr-2">[{{ formatTime(msg.createdAt) }}]</span>
                    <span class="px-1 py-0 text-[8px] font-bold uppercase tracking-widest rounded-sm mr-2 shrink-0 border opacity-70" [class]="getAgentRoleColor(msg).badge">
                      {{ getRoleBadge(msg) }}
                    </span>
                    <span class="text-sm" [class]="getAgentRoleColor(msg).text">{{ msg.content }}</span>
                  </div>
                }
              }
              @default {
                <div class="flex gap-2 py-0.5">
                  <span class="text-slate-700 shrink-0 text-xs">[{{ formatTime(msg.createdAt) }}]</span>
                  <span class="text-indigo-400 text-sm">{{ msg.content }}</span>
                </div>
              }
            }
          }
          @if (messages().length === 0 && !isStreaming()) {
            <p class="text-indigo-500">> {{ 'project.systemReady' | translate }}</p>
          }
          @if (isStreaming() && streamingContent()) {
            <div class="flex gap-2">
              <span class="text-slate-700 shrink-0">[...]</span>
              <span class="text-emerald-400">{{ streamingContent() }}<span class="animate-pulse">&#9610;</span></span>
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

        <!-- Clarification Banner -->
        @if (waitingForInput()) {
          <div class="mx-5 mb-1 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 animate-pulse-slow">
            <div class="flex items-center gap-2 mb-1.5">
              <app-icon name="message-circle-question" [size]="14" class="text-amber-400 shrink-0" />
              <span class="text-[10px] font-mono text-amber-400 uppercase tracking-wider">
                {{ 'chat.clarificationFrom' | translate:{ agent: waitingForInput()!.agentRole } }}
              </span>
            </div>
            <p class="text-sm text-slate-300 mb-2">{{ waitingForInput()!.question }}</p>
            @if (waitingForInput()!.options && waitingForInput()!.options!.length > 0) {
              <div class="flex flex-wrap gap-2">
                @for (opt of waitingForInput()!.options!; track opt) {
                  <button
                    (click)="useClarificationOption(opt)"
                    class="px-3 py-1 rounded-full bg-amber-500/10 text-amber-300 text-xs font-medium border border-amber-500/30 hover:bg-amber-500/20 hover:border-amber-500/50 transition-all cursor-pointer"
                  >
                    {{ opt }}
                  </button>
                }
              </div>
            }
          </div>
        }

        <!-- Voice Conversation Overlay -->
        @if (voice.isVoiceMode()) {
          <div class="absolute inset-0 z-20 bg-slate-900/85 backdrop-blur-xl flex flex-col items-center justify-center gap-6 rounded-3xl">
            <!-- Close button -->
            <button
              (click)="voice.exitVoiceMode()"
              class="absolute top-4 right-4 text-slate-500 hover:text-white transition-colors p-2"
            >
              <app-icon name="x" [size]="20" />
            </button>

            <!-- State: LISTENING (hands-free with VAD) -->
            @if (voice.voiceState() === 'LISTENING') {
              <div class="relative flex items-center justify-center">
                <!-- Reactive audio ring -->
                <div
                  class="absolute rounded-full bg-sky-400/10 transition-transform duration-100"
                  [style.width.px]="96 + voice.audioLevel() * 60"
                  [style.height.px]="96 + voice.audioLevel() * 60"
                ></div>
                <div
                  class="absolute rounded-full border border-sky-400/20 transition-transform duration-100"
                  [style.width.px]="96 + voice.audioLevel() * 100"
                  [style.height.px]="96 + voice.audioLevel() * 100"
                ></div>
                <!-- Mic icon circle -->
                <div class="w-24 h-24 rounded-full bg-sky-500/20 border-2 border-sky-500/40 flex items-center justify-center z-10">
                  <app-icon name="mic" [size]="36" class="text-sky-400" />
                </div>
              </div>
              <span class="text-sky-400 text-sm font-medium tracking-wide">{{ 'voice.listening' | translate }}</span>
              <p class="text-slate-600 text-xs">{{ 'voice.vadHint' | translate }}</p>
            }

            <!-- State: PROCESSING (STT + Agent thinking) -->
            @if (voice.voiceState() === 'PROCESSING') {
              <div class="w-24 h-24 rounded-full bg-amber-500/20 border-2 border-amber-500/40 flex items-center justify-center">
                <app-icon name="loader-2" [size]="36" class="text-amber-400 animate-spin" />
              </div>
              <span class="text-amber-400 text-sm font-medium tracking-wide">{{ 'voice.processing' | translate }}</span>
              @if (voice.transcript()) {
                <p class="text-slate-400 text-sm max-w-md text-center italic">"{{ voice.transcript() }}"</p>
              }
            }

            <!-- State: SPEAKING (TTS playing) -->
            @if (voice.voiceState() === 'SPEAKING') {
              <div class="w-24 h-24 rounded-full bg-emerald-500/20 border-2 border-emerald-500/40 flex items-center justify-center">
                <div class="flex items-end gap-1 h-8">
                  <span class="w-1 bg-emerald-400 rounded-full animate-bounce" style="height: 8px; animation-delay: 0ms; animation-duration: 0.6s"></span>
                  <span class="w-1 bg-emerald-400 rounded-full animate-bounce" style="height: 16px; animation-delay: 0.1s; animation-duration: 0.6s"></span>
                  <span class="w-1 bg-emerald-400 rounded-full animate-bounce" style="height: 24px; animation-delay: 0.2s; animation-duration: 0.6s"></span>
                  <span class="w-1 bg-emerald-400 rounded-full animate-bounce" style="height: 16px; animation-delay: 0.3s; animation-duration: 0.6s"></span>
                  <span class="w-1 bg-emerald-400 rounded-full animate-bounce" style="height: 8px; animation-delay: 0.4s; animation-duration: 0.6s"></span>
                </div>
              </div>
              <span class="text-emerald-400 text-sm font-medium tracking-wide">{{ 'voice.speaking' | translate }}</span>
              <button
                (click)="voice.stopPlayback(); voice.exitVoiceMode()"
                class="px-5 py-2 rounded-xl bg-slate-700/50 text-slate-400 text-xs border border-white/10 hover:bg-slate-700 transition-all"
              >
                <app-icon name="square" [size]="12" class="inline mr-1.5" />
                Stop
              </button>
            }
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
                (click)="voice.toggleVoiceMode()"
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
                (click)="sessionOpened.emit(infraSession()!)"
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
                (click)="openNewSessionModal()"
                class="text-slate-600 hover:text-indigo-400 transition-colors"
                [title]="'session.new' | translate"
              >
                <app-icon name="plus" [size]="14" />
              </button>
            </div>
            @for (s of devSessions(); track s.id) {
              <div
                class="flex items-center justify-between bg-black/30 rounded-xl p-3 mb-2 cursor-pointer hover:bg-black/40 transition-colors"
                (click)="sessionOpened.emit(s)"
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
                    (click)="sessionOpened.emit(s)"
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
                <span class="text-slate-700">--- {{ 'session.branchAutoGen' | translate }}</span>
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
              (click)="confirmArchive()"
              class="px-5 py-2 rounded-xl text-sm font-medium bg-amber-600 text-white hover:bg-amber-500 transition-colors shadow-lg shadow-amber-500/20"
            >{{ 'session.archived' | translate }}</button>
          </div>
        </div>
      </div>
    }
  `,
})
export class ChatPanelComponent implements OnInit, OnDestroy {
  private api = inject(ApiService);
  private chatSocket = inject(ChatSocketService);
  private i18n = inject(TranslateService);
  voice = inject(VoiceService);

  // ---- Inputs ----

  /** The project ID */
  projectId = input.required<string>();

  /** The project slug (for API calls) */
  projectSlug = input.required<string>();

  /** Active chat session */
  activeSession = input<ChatSession | null>(null);

  /** Whether agents are working (for typing indicator) */
  hasWorkingAgent = input(false);

  /** Infrastructure session */
  infraSession = input<ChatSession | null>(null);

  /** Active dev sessions */
  devSessions = input<ChatSession[]>([]);

  /** Archived sessions */
  archivedSessions = input<ChatSession[]>([]);

  // ---- Outputs ----

  /** Emitted when a session is opened */
  sessionOpened = output<ChatSession>();

  /** Emitted when current session should be closed */
  closeSessionClicked = output<void>();

  /** Emitted when archive is confirmed */
  archiveConfirmed = output<void>();

  /** Emitted when a new dev session is created */
  devSessionCreated = output<{ title: string; branch?: string }>();

  /** Emitted when pipeline should be resumed from suggestion */
  resumePipeline = output<void>();

  // ---- Internal state ----

  messages = signal<ChatMessage[]>([]);
  messageInput = '';
  streamingContent = signal('');
  isStreaming = signal(false);
  suggestions = signal<string[]>([]);
  interviewProgress = signal<InterviewProgress | null>(null);
  activeTab = signal<'chat' | 'log'>('chat');
  waitingForInput = signal<{ question: string; options?: string[]; agentRole: string } | null>(null);

  filteredMessages = computed(() => {
    const msgs = this.messages();
    if (this.activeTab() === 'log') {
      // Agent Log: only internal agent messages (findings, status, MCP details)
      return msgs.filter(m =>
        m.visibility === 'AGENT_INTERNAL' ||
        (m.role === 'AGENT' && m.visibility && m.visibility !== 'USER_FACING')
      );
    }
    // Chat: only user-facing messages (user questions, agent results, summaries, clarifications)
    return msgs.filter(m =>
      m.role === 'USER' || m.role === 'SYSTEM' ||
      !m.visibility || m.visibility === 'USER_FACING'
    );
  });

  showNewSessionModal = signal(false);
  showArchiveModal = signal(false);
  showArchive = signal(false);
  newSessionTitle = '';
  newSessionBranch = '';

  private messageContainer = viewChild<ElementRef>('messageContainer');
  private socketSub: Subscription | null = null;
  private streamStartSub: Subscription | null = null;
  private streamTokenSub: Subscription | null = null;
  private streamEndSub: Subscription | null = null;
  private suggestionsSub: Subscription | null = null;
  private progressSub: Subscription | null = null;
  private clarificationSub: Subscription | null = null;

  constructor() {
    // Auto-scroll when messages change
    effect(() => {
      this.messages();
      setTimeout(() => this.scrollToBottom(), 50);
    });
  }

  ngOnInit() {
    this.socketSub = this.chatSocket.newMessage$.subscribe((msg) => {
      this.messages.update((msgs) => [...msgs, msg]);
    });

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

    this.clarificationSub = this.chatSocket.clarificationRequired$.subscribe((event) => {
      this.waitingForInput.set({
        question: event.question,
        options: event.options,
        agentRole: event.agentRole,
      });
    });
  }

  ngOnDestroy() {
    this.socketSub?.unsubscribe();
    this.streamStartSub?.unsubscribe();
    this.streamTokenSub?.unsubscribe();
    this.streamEndSub?.unsubscribe();
    this.suggestionsSub?.unsubscribe();
    this.progressSub?.unsubscribe();
    this.clarificationSub?.unsubscribe();
  }

  /** Load messages for the given session */
  loadMessages(sessionId: string) {
    this.chatSocket.joinSession(sessionId);
    this.voice.setupSocketListeners();
    this.api.getChatMessages(sessionId).subscribe((msgs) => {
      this.messages.set(msgs);
    });
  }

  /** Clear messages and leave socket room */
  clearMessages() {
    this.chatSocket.leaveSession();
    this.messages.set([]);
    this.waitingForInput.set(null);
  }

  /** Called from parent when new session modal should open */
  openNewSessionModal() {
    this.showNewSessionModal.set(true);
  }

  /** Called from parent when archive confirm modal should open */
  openArchiveModal() {
    this.showArchiveModal.set(true);
  }

  sendMessage() {
    const session = this.activeSession();
    const content = this.messageInput.trim();
    if (!session || !content) return;

    this.suggestions.set([]);
    this.waitingForInput.set(null);

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
    if (text.includes('Resume pipeline')) {
      this.resumePipeline.emit();
      this.suggestions.set([]);
      return;
    }
    this.messageInput = text;
    this.sendMessage();
  }

  useClarificationOption(option: string) {
    this.messageInput = option;
    this.sendMessage();
  }

  onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    const session = this.activeSession();
    if (!file || !session) return;

    if (file.size > 10 * 1024 * 1024) {
      alert('File too large (max 10 MB)');
      input.value = '';
      return;
    }

    this.api.uploadChatFile(session.id, file).subscribe({
      next: (msg) => {
        this.messages.update((msgs) => [...msgs, msg]);
      },
      error: () => {
        alert(this.i18n.t('chat.uploadFailed'));
      },
    });

    input.value = '';
  }

  autoGenerateBranch(title: string) {
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .substring(0, 40);
    this.newSessionBranch = slug ? `session/${slug}` : '';
  }

  createDevSession() {
    const title = this.newSessionTitle.trim();
    if (!title) return;

    this.devSessionCreated.emit({
      title,
      branch: this.newSessionBranch.trim() || undefined,
    });
    this.showNewSessionModal.set(false);
    this.newSessionTitle = '';
    this.newSessionBranch = '';
  }

  confirmArchive() {
    this.showArchiveModal.set(false);
    this.archiveConfirmed.emit();
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

  /** Get agent role color classes based on role name in message metadata or content */
  getAgentRoleColor(msg: any): { border: string; text: string; bg: string; badge: string } {
    const content = (msg.content || '').toLowerCase();
    const meta = msg.metadata as any;
    const role = meta?.agentRole || '';

    const colors: Record<string, { border: string; text: string; bg: string; badge: string }> = {
      'INTERVIEWER':       { border: 'border-l-sky-500', text: 'text-sky-400', bg: 'bg-sky-500/5', badge: 'bg-sky-500/20 text-sky-400 border-sky-500/30' },
      'ARCHITECT':         { border: 'border-l-violet-500', text: 'text-violet-400', bg: 'bg-violet-500/5', badge: 'bg-violet-500/20 text-violet-400 border-violet-500/30' },
      'ISSUE_COMPILER':    { border: 'border-l-amber-500', text: 'text-amber-400', bg: 'bg-amber-500/5', badge: 'bg-amber-500/20 text-amber-400 border-amber-500/30' },
      'CODER':             { border: 'border-l-indigo-500', text: 'text-indigo-400', bg: 'bg-indigo-500/5', badge: 'bg-indigo-500/20 text-indigo-400 border-indigo-500/30' },
      'CODE_REVIEWER':     { border: 'border-l-emerald-500', text: 'text-emerald-400', bg: 'bg-emerald-500/5', badge: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' },
      'UI_TESTER':         { border: 'border-l-pink-500', text: 'text-pink-400', bg: 'bg-pink-500/5', badge: 'bg-pink-500/20 text-pink-400 border-pink-500/30' },
      'FUNCTIONAL_TESTER': { border: 'border-l-teal-500', text: 'text-teal-400', bg: 'bg-teal-500/5', badge: 'bg-teal-500/20 text-teal-400 border-teal-500/30' },
      'PEN_TESTER':        { border: 'border-l-red-500', text: 'text-red-400', bg: 'bg-red-500/5', badge: 'bg-red-500/20 text-red-400 border-red-500/30' },
      'DOCUMENTER':        { border: 'border-l-cyan-500', text: 'text-cyan-400', bg: 'bg-cyan-500/5', badge: 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30' },
      'DEVOPS':            { border: 'border-l-orange-500', text: 'text-orange-400', bg: 'bg-orange-500/5', badge: 'bg-orange-500/20 text-orange-400 border-orange-500/30' },
    };

    // Try role from metadata first
    if (role && colors[role]) return colors[role];

    // Auto-detect from content
    if (content.includes('**code review')) return colors['CODE_REVIEWER'];
    if (content.includes('**functional test')) return colors['FUNCTIONAL_TESTER'];
    if (content.includes('**ui test')) return colors['UI_TESTER'];
    if (content.includes('**pen test')) return colors['PEN_TESTER'];
    if (content.includes('**documentation')) return colors['DOCUMENTER'];
    if (content.includes('devops') || content.includes('setup complete')) return colors['DEVOPS'];
    if (content.includes('architect')) return colors['ARCHITECT'];
    if (content.includes('interviewer') || content.includes('requirements')) return colors['INTERVIEWER'];

    return { border: 'border-l-emerald-500', text: 'text-emerald-400', bg: 'bg-emerald-500/5', badge: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' };
  }

  /** Detect if message is a clarification question */
  isClarification(msg: any): boolean {
    return !!(msg.metadata as any)?.clarificationRequest;
  }

  /** Detect if message is a result (pass/fail) */
  isResult(msg: any): boolean {
    const c = (msg.content || '').toLowerCase();
    return c.includes('approved') || c.includes('passed') || c.includes('failed') || c.includes('changes requested');
  }

  /** Get short role name for badge */
  getRoleBadge(msg: any): string {
    const meta = msg.metadata as any;
    const role = meta?.agentRole || '';
    const names: Record<string, string> = {
      'INTERVIEWER': 'Interviewer', 'ARCHITECT': 'Architect', 'ISSUE_COMPILER': 'Issues',
      'CODER': 'Coder', 'CODE_REVIEWER': 'Reviewer', 'UI_TESTER': 'UI Test',
      'FUNCTIONAL_TESTER': 'Func Test', 'PEN_TESTER': 'Security', 'DOCUMENTER': 'Docs', 'DEVOPS': 'DevOps',
    };
    if (role && names[role]) return names[role];
    // Auto-detect
    const c = (msg.content || '').toLowerCase();
    if (c.includes('code review')) return 'Reviewer';
    if (c.includes('functional test')) return 'Func Test';
    if (c.includes('ui test')) return 'UI Test';
    if (c.includes('pen test')) return 'Security';
    if (c.includes('documentation')) return 'Docs';
    return 'Agent';
  }

  private scrollToBottom() {
    const el = this.messageContainer()?.nativeElement;
    if (el) el.scrollTop = el.scrollHeight;
  }
}
