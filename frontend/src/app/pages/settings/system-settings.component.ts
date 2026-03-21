import { Component, inject, OnInit, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../services/api.service';
import { IconComponent } from '../../components/icon.component';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { TranslateService } from '../../services/translate.service';

@Component({
  selector: 'app-system-settings',
  standalone: true,
  imports: [FormsModule, IconComponent, TranslatePipe],
  template: `
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

      <!-- Voice (STT/TTS) -->
      <div class="glass card-glow rounded-3xl p-6 animate-in stagger-6">
        <h2 class="text-lg font-semibold text-white mb-6 flex items-center gap-2">
          <app-icon name="mic" [size]="20" class="text-pink-400" />
          {{ 'settings.voice' | translate }}
        </h2>
        <div class="space-y-4">
          <!-- Enable toggle -->
          <div class="flex items-center justify-between">
            <div>
              <span class="text-sm font-medium text-slate-300">{{ 'settings.voiceEnabled' | translate }}</span>
              <p class="text-xs text-slate-500">{{ 'settings.voiceEnabledHint' | translate }}</p>
            </div>
            <label class="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                [checked]="sysValues['voice.enabled'] === 'true'"
                (change)="sysValues['voice.enabled'] = sysValues['voice.enabled'] === 'true' ? 'false' : 'true'"
                class="sr-only peer"
              />
              <div class="w-11 h-6 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-pink-500"></div>
            </label>
          </div>
          <!-- STT Settings -->
          <div class="border-t border-white/5 pt-4">
            <h3 class="text-sm font-semibold text-slate-400 mb-3">{{ 'settings.voiceStt' | translate }}</h3>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label class="block text-xs font-medium text-slate-500 mb-1">{{ 'settings.voiceSttUrl' | translate }}</label>
                <input
                  type="text"
                  [(ngModel)]="sysValues['voice.stt.url']"
                  class="w-full bg-slate-900/50 border border-white/10 rounded-xl px-4 py-2.5 text-white text-sm focus:outline-none focus:border-pink-500/50 transition-colors"
                  placeholder="http://localhost:8300"
                />
              </div>
              <div>
                <label class="block text-xs font-medium text-slate-500 mb-1">{{ 'settings.voiceSttModel' | translate }}</label>
                <input
                  type="text"
                  [(ngModel)]="sysValues['voice.stt.model']"
                  class="w-full bg-slate-900/50 border border-white/10 rounded-xl px-4 py-2.5 text-white text-sm focus:outline-none focus:border-pink-500/50 transition-colors"
                  placeholder="large-v3-turbo"
                />
              </div>
              <div>
                <label class="block text-xs font-medium text-slate-500 mb-1">{{ 'settings.voiceSttLanguage' | translate }}</label>
                <select
                  [(ngModel)]="sysValues['voice.stt.language']"
                  class="w-full bg-slate-900/50 border border-white/10 rounded-xl px-4 py-2.5 text-white text-sm focus:outline-none focus:border-pink-500/50 transition-colors"
                >
                  <option value="auto">Auto-detect</option>
                  <option value="de">Deutsch</option>
                  <option value="en">English</option>
                  <option value="it">Italiano</option>
                  <option value="fr">Français</option>
                </select>
              </div>
            </div>
          </div>
          <!-- TTS Settings -->
          <div class="border-t border-white/5 pt-4">
            <h3 class="text-sm font-semibold text-slate-400 mb-3">{{ 'settings.voiceTts' | translate }}</h3>
            <div class="space-y-4">
              <!-- Engine selector -->
              <div>
                <label class="block text-xs font-medium text-slate-500 mb-2">{{ 'settings.voiceTtsEngine' | translate }}</label>
                <div class="flex gap-2">
                  @for (eng of ttsEngines; track eng.id) {
                    <button
                      (click)="selectTtsEngine(eng.id)"
                      class="flex-1 px-4 py-3 rounded-xl border text-sm font-medium transition-all"
                      [class]="
                        (sysValues['voice.tts.engine'] || 'piper') === eng.id
                          ? 'border-pink-500/40 bg-pink-500/10 text-pink-400'
                          : 'border-white/10 bg-slate-900/50 text-slate-500 hover:text-slate-300 hover:border-white/20'
                      "
                    >
                      <div class="font-semibold">{{ eng.name }}</div>
                      <div class="text-[10px] mt-0.5 opacity-60">{{ eng.hint }}</div>
                    </button>
                  }
                </div>
              </div>
              <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label class="block text-xs font-medium text-slate-500 mb-1">{{ 'settings.voiceTtsUrl' | translate }}</label>
                  <input
                    type="text"
                    [(ngModel)]="sysValues['voice.tts.url']"
                    class="w-full bg-slate-900/50 border border-white/10 rounded-xl px-4 py-2.5 text-white text-sm focus:outline-none focus:border-pink-500/50 transition-colors"
                    [placeholder]="getTtsDefaultUrl()"
                  />
                </div>
                <div>
                  <label class="block text-xs font-medium text-slate-500 mb-1">{{ 'settings.voiceTtsVoice' | translate }}</label>
                  @if (ttsVoicesList().length > 0) {
                    <select
                      [(ngModel)]="sysValues['voice.tts.voice']"
                      class="w-full bg-slate-900/50 border border-white/10 rounded-xl px-4 py-2.5 text-white text-sm focus:outline-none focus:border-pink-500/50 transition-colors"
                    >
                      @for (v of ttsVoicesList(); track v.id) {
                        <option [value]="v.id">{{ v.name }} @if (v.locale) { ({{ v.locale }}) } @if (v.quality) { [{{ v.quality }}] }</option>
                      }
                    </select>
                  } @else {
                    <input
                      type="text"
                      [(ngModel)]="sysValues['voice.tts.voice']"
                      class="w-full bg-slate-900/50 border border-white/10 rounded-xl px-4 py-2.5 text-white text-sm focus:outline-none focus:border-pink-500/50 transition-colors"
                      [placeholder]="getTtsDefaultVoice()"
                    />
                  }
                </div>
                <div>
                  <label class="block text-xs font-medium text-slate-500 mb-1">{{ 'settings.voiceTtsLanguage' | translate }}</label>
                  <select
                    [(ngModel)]="sysValues['voice.tts.language']"
                    class="w-full bg-slate-900/50 border border-white/10 rounded-xl px-4 py-2.5 text-white text-sm focus:outline-none focus:border-pink-500/50 transition-colors"
                  >
                    <option value="auto">Auto-detect</option>
                    <option value="de">Deutsch</option>
                    <option value="en">English</option>
                    <option value="it">Italiano</option>
                    <option value="fr">Français</option>
                    <option value="es">Español</option>
                    <option value="ja">日本語</option>
                    <option value="zh">中文</option>
                    <option value="ko">한국어</option>
                  </select>
                  <p class="text-[10px] text-slate-600 mt-1">{{ 'settings.voiceTtsLanguageHint' | translate }}</p>
                </div>
                <div>
                  <label class="block text-xs font-medium text-slate-500 mb-1">
                    {{ 'settings.voiceTtsSpeed' | translate }}: {{ sysValues['voice.tts.speed'] || '1.0' }}x
                  </label>
                  <input
                    type="range"
                    min="0.5"
                    max="2.0"
                    step="0.1"
                    [ngModel]="sysValues['voice.tts.speed'] || '1.0'"
                    (ngModelChange)="sysValues['voice.tts.speed'] = $event"
                    class="w-full accent-pink-500"
                  />
                  <div class="flex justify-between text-[10px] text-slate-600 mt-1">
                    <span>0.5x</span>
                    <span>1.0x</span>
                    <span>2.0x</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <!-- Health Check -->
          <div class="border-t border-white/5 pt-4">
            <div class="flex items-center gap-3">
              <button
                (click)="checkVoiceHealth()"
                [disabled]="voiceHealthLoading()"
                class="bg-pink-600/20 hover:bg-pink-600/30 border border-pink-500/20 text-pink-400 px-4 py-2 rounded-xl text-sm font-medium transition-all flex items-center gap-2"
              >
                <app-icon name="activity" [size]="14" />
                {{ 'settings.voiceHealthCheck' | translate }}
              </button>
              <button
                (click)="loadTtsVoices()"
                [disabled]="ttsVoicesLoading()"
                class="bg-slate-700/50 hover:bg-slate-700 border border-white/10 text-slate-400 px-4 py-2 rounded-xl text-sm font-medium transition-all flex items-center gap-2"
              >
                <app-icon name="list" [size]="14" [class]="ttsVoicesLoading() ? 'animate-spin' : ''" />
                {{ 'settings.voiceLoadVoices' | translate }}
              </button>
            </div>
            @if (voiceHealth()) {
              <div class="flex items-center gap-4 mt-3">
                <div class="flex items-center gap-2">
                  <span class="w-2 h-2 rounded-full" [class]="voiceHealth()!.stt ? 'bg-emerald-400' : 'bg-red-400'"></span>
                  <span class="text-xs text-slate-400">STT</span>
                </div>
                <div class="flex items-center gap-2">
                  <span class="w-2 h-2 rounded-full" [class]="voiceHealth()!.tts ? 'bg-emerald-400' : 'bg-red-400'"></span>
                  <span class="text-xs text-slate-400">TTS
                    @if (voiceHealth()!.ttsEngine) {
                      <span class="text-slate-600">({{ voiceHealth()!.ttsEngine }})</span>
                    }
                  </span>
                </div>
                @if (voiceHealth()!.ttsVoices) {
                  <span class="text-xs text-slate-600">{{ voiceHealth()!.ttsVoices }} {{ 'settings.voiceTtsVoicesCount' | translate }}</span>
                }
              </div>
            }
          </div>
        </div>
      </div>

      <!-- CORS / Security -->
      <div class="glass card-glow rounded-3xl p-6 animate-in stagger-7">
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
      <div class="glass card-glow rounded-3xl p-6 animate-in stagger-8">
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
      <div class="flex justify-end animate-in stagger-9">
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
  `,
})
export class SystemSettingsComponent implements OnInit {
  private api = inject(ApiService);
  private i18n = inject(TranslateService);

  saved = output<{ type: 'success' | 'error'; message: string }>();

  saving = signal(false);

  sysValues: Record<string, string> = {};
  showSecrets: Record<string, boolean> = {};
  corsOriginsText = '';
  private originalMaskedValues: Record<string, string> = {};

  // Voice health check
  voiceHealth = signal<{ stt: boolean; tts: boolean; ttsEngine?: string; ttsVoices?: number } | null>(null);
  voiceHealthLoading = signal(false);
  ttsVoicesList = signal<{ id: string; name: string; locale?: string; quality?: string }[]>([]);
  ttsVoicesLoading = signal(false);

  // TTS engine definitions
  ttsEngines = [
    { id: 'piper', name: 'Piper', hint: 'CPU, schnell, ~0.07s', url: 'http://localhost:8302', voice: 'de_DE-thorsten_emotional-medium' },
    { id: 'qwen3', name: 'Qwen3-TTS', hint: 'GPU, natuerlich, ~3s', url: 'http://localhost:8301', voice: 'serena' },
    { id: 'f5-tts', name: 'F5-TTS', hint: 'GPU, Voice Cloning', url: 'http://localhost:8303', voice: 'default' },
    { id: 'chatterbox', name: 'Chatterbox', hint: 'GPU, DE perfekt, ~1.3s', url: 'http://localhost:8304', voice: 'thorsten_de' },
  ];

  ngOnInit() {
    this.loadSystemSettings();
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

  selectTtsEngine(engineId: string) {
    this.sysValues['voice.tts.engine'] = engineId;
    const engine = this.ttsEngines.find(e => e.id === engineId);
    if (engine) {
      this.sysValues['voice.tts.url'] = engine.url;
      this.sysValues['voice.tts.voice'] = engine.voice;
    }
    // Clear cached voices list when engine changes
    this.ttsVoicesList.set([]);
  }

  getTtsDefaultUrl(): string {
    const engine = this.ttsEngines.find(e => e.id === (this.sysValues['voice.tts.engine'] || 'piper'));
    return engine?.url ?? 'http://localhost:8302';
  }

  getTtsDefaultVoice(): string {
    const engine = this.ttsEngines.find(e => e.id === (this.sysValues['voice.tts.engine'] || 'piper'));
    return engine?.voice ?? 'default';
  }

  loadTtsVoices() {
    this.ttsVoicesLoading.set(true);
    this.api.getVoiceVoices().subscribe({
      next: (result) => {
        this.ttsVoicesList.set(result.voices);
        this.ttsVoicesLoading.set(false);
      },
      error: () => {
        this.ttsVoicesList.set([]);
        this.ttsVoicesLoading.set(false);
      },
    });
  }

  checkVoiceHealth() {
    this.voiceHealthLoading.set(true);
    this.voiceHealth.set(null);
    this.api.getVoiceHealth().subscribe({
      next: (health) => {
        this.voiceHealth.set(health);
        this.voiceHealthLoading.set(false);
      },
      error: () => {
        this.voiceHealth.set({ stt: false, tts: false });
        this.voiceHealthLoading.set(false);
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

    // Voice settings
    const voiceKeys = [
      'voice.enabled',
      'voice.stt.url',
      'voice.stt.model',
      'voice.stt.language',
      'voice.tts.engine',
      'voice.tts.url',
      'voice.tts.voice',
      'voice.tts.language',
      'voice.tts.speed',
    ];
    for (const key of voiceKeys) {
      if (this.sysValues[key] !== undefined && this.sysValues[key] !== '') {
        settings.push({ key, value: this.sysValues[key], category: 'voice' });
      }
    }

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
        this.saved.emit({ type: 'success', message: this.i18n.t('settings.systemSaved') });
      },
      error: () => {
        this.saving.set(false);
        this.saved.emit({ type: 'error', message: this.i18n.t('settings.savedError') });
      },
    });
  }

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
}
