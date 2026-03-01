import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { decrypt } from './crypto.util';

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

  get ollamaUrl(): string {
    return this.get('llm.ollama.url', 'OLLAMA_URL', 'http://127.0.0.1:11434');
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

  getAgentDefault(role: string): { provider: string; model: string } {
    const raw = this.get(`agents.defaults.${role}`, undefined, '');
    if (raw) {
      try {
        return JSON.parse(raw);
      } catch {
        /* fall through */
      }
    }
    return { provider: 'OLLAMA', model: 'llama3.1' };
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
