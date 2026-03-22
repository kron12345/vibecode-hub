import { Component, inject, OnInit, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../services/api.service';
import { IconComponent } from '../../components/icon.component';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { TranslateService } from '../../services/translate.service';

@Component({
  selector: 'app-telegram-settings',
  standalone: true,
  imports: [FormsModule, IconComponent, TranslatePipe],
  template: `
    <div class="space-y-4">
      <!-- Status Indicator -->
      <div class="glass rounded-2xl overflow-hidden animate-in stagger-3">
        <div class="px-6 py-4 flex items-center justify-between">
          <div class="flex items-center gap-3">
            <app-icon name="send" [size]="20" class="text-[#0088cc]" />
            <h2 class="text-lg font-bold text-white">
              {{ 'settings.telegramTitle' | translate }}
            </h2>
          </div>
          <div class="flex items-center gap-2">
            <span
              class="w-2.5 h-2.5 rounded-full"
              [class]="botValid() && chatId() ? 'bg-emerald-400 shadow-lg shadow-emerald-400/30' : 'bg-slate-600'"
            ></span>
            <span class="text-sm" [class]="botValid() && chatId() ? 'text-emerald-400' : 'text-slate-500'">
              @if (botValid() && chatId()) {
                {{ 'settings.telegramConnected' | translate }} &#64;{{ botUsername() }}
              } @else {
                {{ 'settings.telegramNotConnected' | translate }}
              }
            </span>
          </div>
        </div>
      </div>

      <!-- Step 1: Create Bot -->
      <div class="glass card-glow rounded-3xl overflow-hidden animate-in stagger-4">
        <button
          (click)="toggleStep(1)"
          class="w-full px-6 py-4 flex items-center justify-between hover:bg-white/[0.02] transition-colors"
        >
          <div class="flex items-center gap-3">
            <div
              class="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold transition-all"
              [class]="
                currentStep() > 1
                  ? 'bg-emerald-500/20 text-emerald-400'
                  : currentStep() === 1
                    ? 'bg-[#0088cc]/20 text-[#0088cc]'
                    : 'bg-slate-700 text-slate-500'
              "
            >
              @if (currentStep() > 1) {
                <app-icon name="check" [size]="16" />
              } @else {
                1
              }
            </div>
            <span class="font-semibold" [class]="currentStep() === 1 ? 'text-white' : 'text-slate-400'">
              {{ 'settings.telegramStep1Title' | translate }}
            </span>
          </div>
          <app-icon
            [name]="expandedStep() === 1 ? 'chevron-up' : 'chevron-down'"
            [size]="16"
            class="text-slate-500"
          />
        </button>
        @if (expandedStep() === 1) {
          <div class="px-6 pb-6 space-y-4 border-t border-white/5 pt-4">
            <p class="text-sm text-slate-400 leading-relaxed">
              {{ 'settings.telegramStep1Desc' | translate }}
            </p>
            <a
              href="https://t.me/BotFather"
              target="_blank"
              rel="noopener noreferrer"
              class="inline-flex items-center gap-2 bg-[#0088cc]/15 hover:bg-[#0088cc]/25 border border-[#0088cc]/30 text-[#0088cc] px-4 py-2.5 rounded-xl text-sm font-medium transition-all"
            >
              <app-icon name="external-link" [size]="14" />
              Open BotFather
            </a>
            <p class="text-xs text-slate-600">
              {{ 'settings.telegramStep1Hint' | translate }}
            </p>
          </div>
        }
      </div>

      <!-- Step 2: Enter Token -->
      <div class="glass card-glow rounded-3xl overflow-hidden animate-in stagger-5">
        <button
          (click)="toggleStep(2)"
          class="w-full px-6 py-4 flex items-center justify-between hover:bg-white/[0.02] transition-colors"
        >
          <div class="flex items-center gap-3">
            <div
              class="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold transition-all"
              [class]="
                currentStep() > 2
                  ? 'bg-emerald-500/20 text-emerald-400'
                  : currentStep() === 2
                    ? 'bg-[#0088cc]/20 text-[#0088cc]'
                    : 'bg-slate-700 text-slate-500'
              "
            >
              @if (currentStep() > 2) {
                <app-icon name="check" [size]="16" />
              } @else {
                2
              }
            </div>
            <span class="font-semibold" [class]="currentStep() >= 2 ? 'text-white' : 'text-slate-400'">
              {{ 'settings.telegramStep2Title' | translate }}
            </span>
          </div>
          <app-icon
            [name]="expandedStep() === 2 ? 'chevron-up' : 'chevron-down'"
            [size]="16"
            class="text-slate-500"
          />
        </button>
        @if (expandedStep() === 2) {
          <div class="px-6 pb-6 space-y-4 border-t border-white/5 pt-4">
            <div>
              <label class="block text-sm font-medium text-slate-400 mb-2">Bot Token</label>
              <div class="flex gap-2">
                <input
                  type="text"
                  [(ngModel)]="tokenInput"
                  class="flex-1 bg-slate-900/50 border border-white/10 rounded-xl px-4 py-3 text-white font-mono text-sm focus:outline-none focus:border-[#0088cc]/50 transition-colors"
                  placeholder="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"
                />
                <button
                  (click)="pasteToken()"
                  class="bg-slate-700/50 hover:bg-slate-700 border border-white/10 text-slate-400 hover:text-white px-3 rounded-xl transition-all"
                  title="Paste"
                >
                  <app-icon name="clipboard" [size]="16" />
                </button>
              </div>
            </div>
            <div class="flex items-center gap-3">
              <button
                (click)="validateToken()"
                [disabled]="loading() || !tokenInput"
                class="bg-[#0088cc]/20 hover:bg-[#0088cc]/30 border border-[#0088cc]/30 text-[#0088cc] px-4 py-2.5 rounded-xl text-sm font-medium transition-all flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                @if (loading()) {
                  <app-icon name="loader-2" [size]="14" class="animate-spin" />
                } @else {
                  <app-icon name="shield-check" [size]="14" />
                }
                {{ 'settings.telegramValidate' | translate }}
              </button>
              @if (tokenValidated()) {
                @if (botValid()) {
                  <div class="flex items-center gap-2 text-emerald-400 text-sm">
                    <app-icon name="check-circle" [size]="16" />
                    <span>&#64;{{ botUsername() }} ({{ botName() }})</span>
                  </div>
                } @else {
                  <div class="flex items-center gap-2 text-red-400 text-sm">
                    <app-icon name="x-circle" [size]="16" />
                    <span>{{ tokenError() }}</span>
                  </div>
                }
              }
            </div>
          </div>
        }
      </div>

      <!-- Step 3: Connect Account -->
      <div class="glass card-glow rounded-3xl overflow-hidden animate-in stagger-6">
        <button
          (click)="toggleStep(3)"
          class="w-full px-6 py-4 flex items-center justify-between hover:bg-white/[0.02] transition-colors"
          [disabled]="currentStep() < 3"
          [class.opacity-50]="currentStep() < 3"
        >
          <div class="flex items-center gap-3">
            <div
              class="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold transition-all"
              [class]="
                currentStep() > 3
                  ? 'bg-emerald-500/20 text-emerald-400'
                  : currentStep() === 3
                    ? 'bg-[#0088cc]/20 text-[#0088cc]'
                    : 'bg-slate-700 text-slate-500'
              "
            >
              @if (currentStep() > 3) {
                <app-icon name="check" [size]="16" />
              } @else {
                3
              }
            </div>
            <span class="font-semibold" [class]="currentStep() >= 3 ? 'text-white' : 'text-slate-400'">
              {{ 'settings.telegramStep3Title' | translate }}
            </span>
          </div>
          <app-icon
            [name]="expandedStep() === 3 ? 'chevron-up' : 'chevron-down'"
            [size]="16"
            class="text-slate-500"
          />
        </button>
        @if (expandedStep() === 3 && currentStep() >= 3) {
          <div class="px-6 pb-6 space-y-4 border-t border-white/5 pt-4">
            <p class="text-sm text-slate-400 leading-relaxed">
              {{ 'settings.telegramStep3Desc' | translate }}
            </p>
            <div class="flex items-center gap-3">
              <button
                (click)="detectChatId()"
                [disabled]="loading()"
                class="bg-[#0088cc]/20 hover:bg-[#0088cc]/30 border border-[#0088cc]/30 text-[#0088cc] px-4 py-2.5 rounded-xl text-sm font-medium transition-all flex items-center gap-2 disabled:opacity-40"
              >
                @if (loading()) {
                  <app-icon name="loader-2" [size]="14" class="animate-spin" />
                } @else {
                  <app-icon name="scan" [size]="14" />
                }
                {{ 'settings.telegramDetectChatId' | translate }}
              </button>
              @if (chatId()) {
                <div class="flex items-center gap-2 text-emerald-400 text-sm">
                  <app-icon name="check-circle" [size]="16" />
                  <span>{{ chatName() }} ({{ chatId() }})</span>
                </div>
              } @else if (chatIdError()) {
                <div class="flex items-center gap-2 text-red-400 text-sm">
                  <app-icon name="x-circle" [size]="16" />
                  <span>{{ chatIdError() }}</span>
                </div>
              }
            </div>
            @if (chatId()) {
              <div class="bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-3">
                <p class="text-xs text-amber-400">
                  <app-icon name="shield" [size]="12" class="inline mr-1" />
                  {{ 'settings.telegramSecurityNotice' | translate }}
                </p>
              </div>
            }
          </div>
        }
      </div>

      <!-- Step 4: Notification Preferences -->
      <div class="glass card-glow rounded-3xl overflow-hidden animate-in stagger-7">
        <button
          (click)="toggleStep(4)"
          class="w-full px-6 py-4 flex items-center justify-between hover:bg-white/[0.02] transition-colors"
          [disabled]="currentStep() < 4"
          [class.opacity-50]="currentStep() < 4"
        >
          <div class="flex items-center gap-3">
            <div
              class="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold transition-all"
              [class]="
                currentStep() > 4
                  ? 'bg-emerald-500/20 text-emerald-400'
                  : currentStep() === 4
                    ? 'bg-[#0088cc]/20 text-[#0088cc]'
                    : 'bg-slate-700 text-slate-500'
              "
            >
              @if (currentStep() > 4) {
                <app-icon name="check" [size]="16" />
              } @else {
                4
              }
            </div>
            <span class="font-semibold" [class]="currentStep() >= 4 ? 'text-white' : 'text-slate-400'">
              {{ 'settings.telegramStep4Title' | translate }}
            </span>
          </div>
          <app-icon
            [name]="expandedStep() === 4 ? 'chevron-up' : 'chevron-down'"
            [size]="16"
            class="text-slate-500"
          />
        </button>
        @if (expandedStep() === 4 && currentStep() >= 4) {
          <div class="px-6 pb-6 space-y-3 border-t border-white/5 pt-4">
            <!-- Clarification questions -->
            <label class="flex items-start gap-3 cursor-pointer group">
              <input
                type="checkbox"
                [checked]="notifyClarifications()"
                (change)="notifyClarifications.set(!notifyClarifications())"
                class="mt-0.5 w-4 h-4 rounded border-white/20 bg-slate-900/50 text-[#0088cc] focus:ring-[#0088cc]/30 accent-[#0088cc]"
              />
              <div>
                <span class="text-sm text-white group-hover:text-[#0088cc] transition-colors">
                  {{ 'settings.telegramNotifyClarifications' | translate }}
                </span>
              </div>
            </label>
            <!-- Pipeline results -->
            <label class="flex items-start gap-3 cursor-pointer group">
              <input
                type="checkbox"
                [checked]="notifyResults()"
                (change)="notifyResults.set(!notifyResults())"
                class="mt-0.5 w-4 h-4 rounded border-white/20 bg-slate-900/50 text-[#0088cc] focus:ring-[#0088cc]/30 accent-[#0088cc]"
              />
              <div>
                <span class="text-sm text-white group-hover:text-[#0088cc] transition-colors">
                  {{ 'settings.telegramNotifyResults' | translate }}
                </span>
              </div>
            </label>
            <!-- Pipeline errors -->
            <label class="flex items-start gap-3 cursor-pointer group">
              <input
                type="checkbox"
                [checked]="notifyErrors()"
                (change)="notifyErrors.set(!notifyErrors())"
                class="mt-0.5 w-4 h-4 rounded border-white/20 bg-slate-900/50 text-[#0088cc] focus:ring-[#0088cc]/30 accent-[#0088cc]"
              />
              <div>
                <span class="text-sm text-white group-hover:text-[#0088cc] transition-colors">
                  {{ 'settings.telegramNotifyErrors' | translate }}
                </span>
              </div>
            </label>
            <!-- Status updates -->
            <label class="flex items-start gap-3 cursor-pointer group">
              <input
                type="checkbox"
                [checked]="notifyStatus()"
                (change)="notifyStatus.set(!notifyStatus())"
                class="mt-0.5 w-4 h-4 rounded border-white/20 bg-slate-900/50 text-[#0088cc] focus:ring-[#0088cc]/30 accent-[#0088cc]"
              />
              <div>
                <span class="text-sm text-white group-hover:text-[#0088cc] transition-colors">
                  {{ 'settings.telegramNotifyStatus' | translate }}
                </span>
              </div>
            </label>
            <!-- All messages -->
            <label class="flex items-start gap-3 cursor-pointer group">
              <input
                type="checkbox"
                [checked]="notifyAll()"
                (change)="notifyAll.set(!notifyAll())"
                class="mt-0.5 w-4 h-4 rounded border-white/20 bg-slate-900/50 text-[#0088cc] focus:ring-[#0088cc]/30 accent-[#0088cc]"
              />
              <div>
                <span class="text-sm text-white group-hover:text-[#0088cc] transition-colors">
                  {{ 'settings.telegramNotifyAll' | translate }}
                </span>
              </div>
            </label>
          </div>
        }
      </div>

      <!-- Step 5: Test & Save -->
      <div class="glass card-glow rounded-3xl overflow-hidden animate-in stagger-8">
        <button
          (click)="toggleStep(5)"
          class="w-full px-6 py-4 flex items-center justify-between hover:bg-white/[0.02] transition-colors"
          [disabled]="currentStep() < 4"
          [class.opacity-50]="currentStep() < 4"
        >
          <div class="flex items-center gap-3">
            <div
              class="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold transition-all"
              [class]="
                configSaved()
                  ? 'bg-emerald-500/20 text-emerald-400'
                  : currentStep() >= 5
                    ? 'bg-[#0088cc]/20 text-[#0088cc]'
                    : 'bg-slate-700 text-slate-500'
              "
            >
              @if (configSaved()) {
                <app-icon name="check" [size]="16" />
              } @else {
                5
              }
            </div>
            <span class="font-semibold" [class]="currentStep() >= 5 ? 'text-white' : 'text-slate-400'">
              {{ 'settings.telegramStep5Title' | translate }}
            </span>
          </div>
          <app-icon
            [name]="expandedStep() === 5 ? 'chevron-up' : 'chevron-down'"
            [size]="16"
            class="text-slate-500"
          />
        </button>
        @if (expandedStep() === 5 && currentStep() >= 4) {
          <div class="px-6 pb-6 space-y-4 border-t border-white/5 pt-4">
            <div class="flex items-center gap-3 flex-wrap">
              <button
                (click)="sendTestMessage()"
                [disabled]="loading() || !botValid() || !chatId()"
                class="bg-slate-700/50 hover:bg-slate-700 border border-white/10 text-slate-300 hover:text-white px-4 py-2.5 rounded-xl text-sm font-medium transition-all flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                @if (testLoading()) {
                  <app-icon name="loader-2" [size]="14" class="animate-spin" />
                } @else {
                  <app-icon name="send" [size]="14" />
                }
                {{ 'settings.telegramTestMessage' | translate }}
              </button>
              @if (testResult() === 'success') {
                <span class="text-emerald-400 text-sm flex items-center gap-1">
                  <app-icon name="check-circle" [size]="14" />
                  Sent!
                </span>
              } @else if (testResult() === 'error') {
                <span class="text-red-400 text-sm flex items-center gap-1">
                  <app-icon name="x-circle" [size]="14" />
                  Failed
                </span>
              }
            </div>
            <div class="flex items-center gap-3">
              <button
                (click)="saveConfig()"
                [disabled]="saving() || !botValid() || !chatId()"
                class="bg-[#0088cc] hover:bg-[#0099dd] hover:shadow-lg hover:shadow-[#0088cc]/25 hover:scale-[1.02] disabled:opacity-40 disabled:cursor-not-allowed text-white px-6 py-3 rounded-full font-bold transition-all flex items-center gap-2"
              >
                @if (saving()) {
                  <app-icon name="loader-2" [size]="16" class="animate-spin" />
                } @else {
                  <app-icon name="save" [size]="16" />
                }
                {{ 'settings.telegramSave' | translate }}
              </button>
            </div>
          </div>
        }
      </div>
    </div>
  `,
})
export class TelegramSettingsComponent implements OnInit {
  private api = inject(ApiService);
  private i18n = inject(TranslateService);

  saved = output<{ type: 'success' | 'error'; message: string }>();

  // Wizard state
  currentStep = signal(1);
  expandedStep = signal(1);

  // Step 2: Token
  tokenInput = '';
  botToken = signal('');
  botValid = signal(false);
  botName = signal('');
  botUsername = signal('');
  tokenValidated = signal(false);
  tokenError = signal('');
  loading = signal(false);

  // Step 3: Chat ID
  chatId = signal('');
  chatName = signal('');
  chatIdError = signal('');

  // Step 4: Notification preferences
  notifyClarifications = signal(true);
  notifyResults = signal(true);
  notifyErrors = signal(true);
  notifyStatus = signal(false);
  notifyAll = signal(false);

  // Step 5: Save
  testLoading = signal(false);
  testResult = signal<'success' | 'error' | null>(null);
  saving = signal(false);
  configSaved = signal(false);

  ngOnInit() {
    this.loadExistingConfig();
  }

  toggleStep(step: number) {
    if (this.expandedStep() === step) {
      this.expandedStep.set(0);
    } else {
      this.expandedStep.set(step);
    }
  }

  async pasteToken() {
    try {
      const text = await navigator.clipboard.readText();
      this.tokenInput = text.trim();
    } catch {
      // Clipboard API not available or permission denied
    }
  }

  validateToken() {
    if (!this.tokenInput) return;
    this.loading.set(true);
    this.tokenValidated.set(false);
    this.tokenError.set('');

    this.api.validateTelegramToken(this.tokenInput).subscribe({
      next: (result) => {
        this.loading.set(false);
        this.tokenValidated.set(true);
        if (result.valid) {
          this.botToken.set(this.tokenInput);
          this.botValid.set(true);
          this.botName.set(result.botName ?? '');
          this.botUsername.set(result.botUsername ?? '');
          // Auto-advance to step 3
          this.currentStep.set(3);
          this.expandedStep.set(3);
        } else {
          this.botValid.set(false);
          this.tokenError.set(result.error ?? 'Invalid token');
        }
      },
      error: () => {
        this.loading.set(false);
        this.tokenValidated.set(true);
        this.botValid.set(false);
        this.tokenError.set('Connection error');
      },
    });
  }

  detectChatId() {
    this.loading.set(true);
    this.chatIdError.set('');

    this.api.detectTelegramChatId(this.botToken()).subscribe({
      next: (result) => {
        this.loading.set(false);
        if (result.found) {
          this.chatId.set(result.chatId ?? '');
          this.chatName.set(
            result.firstName
              ? `${result.firstName}${result.username ? ' (@' + result.username + ')' : ''}`
              : result.username ?? 'Unknown',
          );
          // Auto-advance to step 4
          this.currentStep.set(4);
          this.expandedStep.set(4);
        } else {
          this.chatIdError.set(result.error ?? 'No messages found. Send a message to the bot first.');
        }
      },
      error: () => {
        this.loading.set(false);
        this.chatIdError.set('Connection error');
      },
    });
  }

  sendTestMessage() {
    this.testLoading.set(true);
    this.testResult.set(null);

    this.api.sendTelegramTest(this.botToken(), this.chatId()).subscribe({
      next: (result) => {
        this.testLoading.set(false);
        this.testResult.set(result.success ? 'success' : 'error');
      },
      error: () => {
        this.testLoading.set(false);
        this.testResult.set('error');
      },
    });
  }

  saveConfig() {
    this.saving.set(true);
    const config = {
      botToken: this.botToken(),
      chatId: this.chatId(),
      notifications: {
        clarifications: this.notifyClarifications(),
        results: this.notifyResults(),
        errors: this.notifyErrors(),
        status: this.notifyStatus(),
        all: this.notifyAll(),
      },
    };

    this.api.saveTelegramConfig(config).subscribe({
      next: () => {
        this.saving.set(false);
        this.configSaved.set(true);
        this.currentStep.set(5);
        this.saved.emit({ type: 'success', message: this.i18n.t('settings.telegramSaved') });
      },
      error: () => {
        this.saving.set(false);
        this.saved.emit({ type: 'error', message: this.i18n.t('settings.savedError') });
      },
    });
  }

  private loadExistingConfig() {
    this.api.getTelegramConfig().subscribe({
      next: (config) => {
        if (config?.botToken) {
          this.botToken.set(config.botToken);
          this.tokenInput = config.botToken;
          this.botValid.set(true);
          this.botName.set(config.botName ?? '');
          this.botUsername.set(config.botUsername ?? '');
          this.tokenValidated.set(true);

          if (config.chatId) {
            this.chatId.set(config.chatId);
            this.chatName.set(config.chatName ?? '');
            this.currentStep.set(4);

            if (config.notifications) {
              this.notifyClarifications.set(config.notifications.clarifications ?? true);
              this.notifyResults.set(config.notifications.results ?? true);
              this.notifyErrors.set(config.notifications.errors ?? true);
              this.notifyStatus.set(config.notifications.status ?? false);
              this.notifyAll.set(config.notifications.all ?? false);
            }

            this.currentStep.set(5);
            this.configSaved.set(true);
            this.expandedStep.set(0); // Collapse all when fully configured
          } else {
            this.currentStep.set(3);
          }
        }
      },
      error: () => {
        // No existing config, start at step 1
      },
    });
  }
}
