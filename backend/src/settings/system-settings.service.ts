import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { decrypt } from './crypto.util';
import { TtsEngine, VoiceConfig } from '../voice/voice.interfaces';

export interface AgentRoleConfig {
  provider: string;
  model: string;
  systemPrompt: string;
  parameters: {
    temperature: number;
    maxTokens: number;
    topP?: number;
  };
  permissions: {
    fileRead: boolean;
    fileWrite: boolean;
    terminal: boolean;
    installPackages: boolean;
    http: boolean;
    gitOperations: boolean;
  };
  pipelinePosition: number;
  /** Enable chain-of-thought reasoning (Ollama think mode) */
  enableReasoning?: boolean;
  description: string;
  color: string;
  icon: string;
  /** Dual-testing: secondary provider (e.g. 'CLAUDE_CODE') */
  dualProvider?: string;
  /** Dual-testing: secondary model (e.g. 'sonnet') */
  dualModel?: string;
  /** Dual-testing strategy: merge (union), consensus (intersection), enrich (primary→secondary) */
  dualStrategy?: 'merge' | 'consensus' | 'enrich';
}

export interface MergeConfig {
  /** Auto-merge after all agents pass */
  autoMerge: boolean;
  /** Merge method: merge commit, squash, or rebase */
  method: 'merge' | 'squash' | 'rebase';
  /** Remove feature branch after merge */
  removeSourceBranch: boolean;
  /** Require manual approval before merge (shows merge button in chat) */
  requireApproval: boolean;
  /** Close GitLab issue after successful merge */
  closeIssueOnMerge: boolean;
}

export interface PipelineConfig {
  enabled: boolean;
  autoStart: boolean;
  requireApproval: boolean;
  maxConcurrentAgents: number;
  timeoutMinutes: number;
  maxParallelOllamaModels: number;
  maxFixAttempts: number;
  merge: MergeConfig;
}

/**
 * Cached config provider that replaces process.env for all configurable values.
 * Fallback chain: DB Cache → process.env → hardcoded default
 */
@Injectable()
export class SystemSettingsService implements OnModuleInit {
  private readonly logger = new Logger(SystemSettingsService.name);
  private cache = new Map<string, string>();

  private get encryptionKey(): string {
    return this.config.get<string>('KEYCLOAK_CLIENT_SECRET', '');
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit() {
    await this.refreshCache();
  }

  async refreshCache(): Promise<void> {
    const rows = await this.prisma.systemSetting.findMany();
    this.cache.clear();
    for (const row of rows) {
      const value = row.encrypted
        ? this.decryptSafe(row.value)
        : row.value;
      this.cache.set(row.key, value);
    }
    this.logger.log(`Settings cache loaded: ${this.cache.size} entries`);
  }

  /** Get a setting value with fallback chain: DB → env → default */
  get(key: string, envKey?: string, defaultValue = ''): string {
    // 1. DB cache
    const cached = this.cache.get(key);
    if (cached !== undefined && cached !== '') return cached;

    // 2. process.env fallback
    if (envKey) {
      const envVal = this.config.get<string>(envKey);
      if (envVal) return envVal;
    }

    // 3. hardcoded default
    return defaultValue;
  }

  // ─── Convenience Getters ─────────────────────────────────────

  get gitlabUrl(): string {
    return this.get('gitlab.url', 'GITLAB_URL', 'https://git.example.com');
  }

  get gitlabToken(): string {
    return this.get('gitlab.api_token', 'GITLAB_API_TOKEN', '');
  }

  get gitlabWebhookSecret(): string {
    return this.get('gitlab.webhook_secret', 'GITLAB_WEBHOOK_SECRET', '');
  }

  /** GitLab user ID to auto-add as Maintainer to new projects (0 = disabled) */
  get gitlabOwnerUserId(): number {
    const val = this.get('gitlab.owner_user_id', 'GITLAB_OWNER_USER_ID', '0');
    return parseInt(val, 10) || 0;
  }

  get ollamaUrl(): string {
    return this.get('llm.ollama.url', 'OLLAMA_URL', 'http://127.0.0.1:11434');
  }

  get searxngUrl(): string {
    return this.get('search.searxng_url', 'SEARXNG_URL', 'http://localhost:8088');
  }

  get anthropicApiKey(): string {
    return this.get('llm.anthropic.api_key', 'ANTHROPIC_API_KEY', '');
  }

  get openaiApiKey(): string {
    return this.get('llm.openai.api_key', 'OPENAI_API_KEY', '');
  }

  get googleApiKey(): string {
    return this.get('llm.google.api_key', 'GOOGLE_AI_API_KEY', '');
  }

  get corsOrigins(): string[] {
    const raw = this.get(
      'cors.origins',
      undefined,
      '["https://hub.example.com","http://localhost:4200"]',
    );
    try {
      return JSON.parse(raw);
    } catch {
      return ['https://hub.example.com', 'http://localhost:4200'];
    }
  }

  get appName(): string {
    return this.get('app.name', undefined, 'VibCode Hub');
  }

  // ─── DevOps Getters ──────────────────────────────────────

  get devopsWorkspacePath(): string {
    return this.get('devops.workspace_path', 'DEVOPS_WORKSPACE_PATH', './workspaces/');
  }

  // ─── Preview Getters ──────────────────────────────────────

  get previewEnabled(): boolean {
    return this.get('preview.enabled', undefined, 'true') === 'true';
  }

  get previewPortMin(): number {
    return parseInt(this.get('preview.port_min', undefined, '5000'), 10);
  }

  get previewPortMax(): number {
    return parseInt(this.get('preview.port_max', undefined, '5999'), 10);
  }

  get previewDomain(): string {
    return this.get('preview.domain', undefined, 'hub.example.com');
  }

  get previewNginxMapPath(): string {
    return this.get(
      'preview.nginx_map_path',
      undefined,
      '/etc/nginx/conf.d/hub-project-map.conf',
    );
  }

  // ─── Voice Getters ──────────────────────────────────────

  get voiceEnabled(): boolean {
    return this.get('voice.enabled', undefined, 'false') === 'true';
  }

  get sttUrl(): string {
    return this.get('voice.stt.url', undefined, 'http://localhost:8300');
  }

  get sttModel(): string {
    return this.get('voice.stt.model', undefined, 'large-v3-turbo');
  }

  get sttLanguage(): string {
    return this.get('voice.stt.language', undefined, 'auto');
  }

  /** TTS engine defaults: engine → { url, defaultVoice } */
  private static readonly TTS_ENGINE_DEFAULTS: Record<TtsEngine, { url: string; voice: string }> = {
    'piper': { url: 'http://localhost:8302', voice: 'de_DE-thorsten_emotional-medium' },
    'qwen3': { url: 'http://localhost:8301', voice: 'serena' },
    'f5-tts': { url: 'http://localhost:8303', voice: 'default' },
    'chatterbox': { url: 'http://localhost:8304', voice: 'thorsten_de' },
  };

  get ttsEngine(): TtsEngine {
    const val = this.get('voice.tts.engine', undefined, 'piper');
    return val as TtsEngine;
  }

  get ttsUrl(): string {
    const customUrl = this.get('voice.tts.url', undefined, '');
    if (customUrl) return customUrl;
    return SystemSettingsService.TTS_ENGINE_DEFAULTS[this.ttsEngine]?.url ?? 'http://localhost:8302';
  }

  get ttsVoice(): string {
    const customVoice = this.get('voice.tts.voice', undefined, '');
    if (customVoice) return customVoice;
    return SystemSettingsService.TTS_ENGINE_DEFAULTS[this.ttsEngine]?.voice ?? 'default';
  }

  get ttsSpeed(): number {
    return parseFloat(this.get('voice.tts.speed', undefined, '1.0')) || 1.0;
  }

  get ttsLanguage(): string {
    return this.get('voice.tts.language', undefined, 'de');
  }

  getVoiceConfig(): VoiceConfig {
    return {
      enabled: this.voiceEnabled,
      sttUrl: this.sttUrl,
      ttsUrl: this.ttsUrl,
      sttModel: this.sttModel,
      sttLanguage: this.sttLanguage,
      ttsEngine: this.ttsEngine,
      ttsVoice: this.ttsVoice,
      ttsLanguage: this.ttsLanguage,
      ttsSpeed: this.ttsSpeed,
    };
  }

  /** Get full agent role config (provider, model, systemPrompt, parameters, permissions, etc.) */
  getAgentRoleConfig(role: string): AgentRoleConfig {
    const raw = this.get(`agents.roles.${role}`, undefined, '');
    if (raw) {
      try {
        return JSON.parse(raw);
      } catch {
        /* fall through */
      }
    }
    return {
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
      description: role,
      color: 'slate',
      icon: 'bot',
    };
  }

  /** Get all agent role configs as a map */
  getAllAgentRoleConfigs(): Record<string, AgentRoleConfig> {
    const roles: Record<string, AgentRoleConfig> = {};
    for (const [key] of this.cache) {
      if (key.startsWith('agents.roles.')) {
        const role = key.replace('agents.roles.', '');
        roles[role] = this.getAgentRoleConfig(role);
      }
    }
    return roles;
  }

  /** Get pipeline config */
  getPipelineConfig(): PipelineConfig {
    const raw = this.get('agents.pipeline', undefined, '');
    if (raw) {
      try {
        return JSON.parse(raw);
      } catch {
        /* fall through */
      }
    }
    return {
      enabled: false,
      autoStart: false,
      requireApproval: true,
      maxConcurrentAgents: 2,
      timeoutMinutes: 30,
      maxParallelOllamaModels: 1,
      maxFixAttempts: 5,
      merge: {
        autoMerge: true,
        method: 'merge',
        removeSourceBranch: true,
        requireApproval: false,
        closeIssueOnMerge: true,
      },
    };
  }

  /** Backwards-compatible: get simple provider+model for a role */
  getAgentDefault(role: string): { provider: string; model: string } {
    const config = this.getAgentRoleConfig(role);
    return { provider: config.provider, model: config.model };
  }

  // ─── Private ─────────────────────────────────────────────────

  private decryptSafe(encrypted: string): string {
    if (!encrypted) return '';
    try {
      return decrypt(encrypted, this.encryptionKey);
    } catch (e) {
      this.logger.warn(`Failed to decrypt setting: ${e.message}`);
      return '';
    }
  }
}
