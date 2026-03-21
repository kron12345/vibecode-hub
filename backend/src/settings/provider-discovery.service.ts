import { Injectable, Logger } from '@nestjs/common';
import { SystemSettingsService } from './system-settings.service';

export interface ProviderModel {
  name: string;
  displayName?: string;
  size?: number;
  parameterSize?: string;
  quantization?: string;
}

export interface CliToolStatus {
  name: string;
  command: string;
  installed: boolean;
  version?: string;
}

export interface ProviderModelsResult {
  provider: string;
  available: boolean;
  models: ProviderModel[];
  error?: string;
}

@Injectable()
export class ProviderDiscoveryService {
  private readonly logger = new Logger(ProviderDiscoveryService.name);

  constructor(private readonly systemSettings: SystemSettingsService) {}

  // ─── Ollama ────────────────────────────────────────────────

  /** Fetch available models from Ollama API /api/tags */
  async discoverOllamaModels(): Promise<ProviderModel[]> {
    const ollamaUrl = this.systemSettings.ollamaUrl;

    try {
      const response = await fetch(`${ollamaUrl}/api/tags`, {
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        this.logger.warn(`Ollama API returned ${response.status}`);
        return [];
      }

      const data = await response.json();
      const models = (data.models ?? []) as Array<{
        name: string;
        size: number;
        modified_at: string;
        details?: {
          parameter_size?: string;
          quantization_level?: string;
        };
      }>;

      return models.map((m) => ({
        name: m.name,
        displayName: m.name,
        size: m.size,
        parameterSize: m.details?.parameter_size,
        quantization: m.details?.quantization_level,
      }));
    } catch (e) {
      this.logger.warn(
        `Failed to connect to Ollama at ${ollamaUrl}: ${e.message}`,
      );
      return [];
    }
  }

  /** Check if Ollama is reachable */
  async checkOllamaHealth(): Promise<boolean> {
    const ollamaUrl = this.systemSettings.ollamaUrl;
    try {
      const response = await fetch(`${ollamaUrl}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  // ─── API Provider Models ───────────────────────────────────

  /** Fetch models from Anthropic API */
  async discoverAnthropicModels(): Promise<ProviderModel[]> {
    const apiKey = this.systemSettings.anthropicApiKey;
    if (!apiKey) return [];

    try {
      const response = await fetch('https://api.anthropic.com/v1/models', {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        this.logger.warn(`Anthropic API returned ${response.status}`);
        return [];
      }

      const data = await response.json();
      return (data.data ?? []).map(
        (m: { id: string; display_name?: string }) => ({
          name: m.id,
          displayName: m.display_name ?? m.id,
        }),
      );
    } catch (e) {
      this.logger.warn(`Failed to fetch Anthropic models: ${e.message}`);
      return [];
    }
  }

  /** Fetch models from OpenAI API */
  async discoverOpenAIModels(): Promise<ProviderModel[]> {
    const apiKey = this.systemSettings.openaiApiKey;
    if (!apiKey) return [];

    try {
      const response = await fetch('https://api.openai.com/v1/models', {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        this.logger.warn(`OpenAI API returned ${response.status}`);
        return [];
      }

      const data = await response.json();
      // Filter to relevant models (GPT, o1, codex — skip embedding, tts, whisper etc.)
      const relevant = (data.data ?? [])
        .filter((m: { id: string }) =>
          /^(gpt-|o[134]-|chatgpt-|codex-)/.test(m.id),
        )
        .sort((a: { id: string }, b: { id: string }) =>
          a.id.localeCompare(b.id),
        );

      return relevant.map((m: { id: string }) => ({
        name: m.id,
        displayName: m.id,
      }));
    } catch (e) {
      this.logger.warn(`Failed to fetch OpenAI models: ${e.message}`);
      return [];
    }
  }

  /** Fetch models from Google AI API */
  async discoverGoogleModels(): Promise<ProviderModel[]> {
    const apiKey = this.systemSettings.googleApiKey;
    if (!apiKey) return [];

    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
        { signal: AbortSignal.timeout(10000) },
      );

      if (!response.ok) {
        this.logger.warn(`Google AI API returned ${response.status}`);
        return [];
      }

      const data = await response.json();
      // Filter to generative models
      return (data.models ?? [])
        .filter((m: { name: string; supportedGenerationMethods?: string[] }) =>
          m.supportedGenerationMethods?.includes('generateContent'),
        )
        .map((m: { name: string; displayName?: string }) => ({
          name: m.name.replace('models/', ''),
          displayName: m.displayName ?? m.name.replace('models/', ''),
        }));
    } catch (e) {
      this.logger.warn(`Failed to fetch Google AI models: ${e.message}`);
      return [];
    }
  }

  /** Get models for all providers at once */
  async discoverAllModels(): Promise<Record<string, ProviderModelsResult>> {
    this.logger.log(
      'discoverAllModels() called — fetching from all providers...',
    );

    const [ollama, anthropic, openai, google] = await Promise.allSettled([
      this.discoverOllamaModels(),
      this.discoverAnthropicModels(),
      this.discoverOpenAIModels(),
      this.discoverGoogleModels(),
    ]);

    this.logger.log(
      `Discovery results — Ollama: ${ollama.status}${ollama.status === 'fulfilled' ? ` (${ollama.value.length} models)` : ''}, ` +
        `Anthropic: ${anthropic.status}, OpenAI: ${openai.status}, Google: ${google.status}`,
    );

    return {
      OLLAMA: {
        provider: 'OLLAMA',
        available: ollama.status === 'fulfilled' && ollama.value.length > 0,
        models: ollama.status === 'fulfilled' ? ollama.value : [],
        error:
          ollama.status === 'rejected' ? ollama.reason?.message : undefined,
      },
      ANTHROPIC: {
        provider: 'ANTHROPIC',
        available:
          anthropic.status === 'fulfilled' && anthropic.value.length > 0,
        models: anthropic.status === 'fulfilled' ? anthropic.value : [],
        error:
          anthropic.status === 'rejected'
            ? anthropic.reason?.message
            : undefined,
      },
      OPENAI: {
        provider: 'OPENAI',
        available: openai.status === 'fulfilled' && openai.value.length > 0,
        models: openai.status === 'fulfilled' ? openai.value : [],
        error:
          openai.status === 'rejected' ? openai.reason?.message : undefined,
      },
      GOOGLE: {
        provider: 'GOOGLE',
        available: google.status === 'fulfilled' && google.value.length > 0,
        models: google.status === 'fulfilled' ? google.value : [],
        error:
          google.status === 'rejected' ? google.reason?.message : undefined,
      },
      // CLI tools don't have model discovery — they use whatever model the tool supports
      CLAUDE_CODE: {
        provider: 'CLAUDE_CODE',
        available: true,
        models: [
          { name: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6' },
          { name: 'claude-opus-4-6', displayName: 'Claude Opus 4.6' },
          { name: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5' },
        ],
      },
      CODEX_CLI: {
        provider: 'CODEX_CLI',
        available: true,
        models: [
          { name: 'gpt-5.4', displayName: 'GPT-5.4 (Allrounder)' },
          {
            name: 'gpt-5.3-codex',
            displayName: 'GPT-5.3-Codex (Code-Spezialist)',
          },
          { name: 'codex-mini-latest', displayName: 'Codex Mini (schnell)' },
        ],
      },
      GEMINI_CLI: {
        provider: 'GEMINI_CLI',
        available: true,
        models: [
          { name: 'gemini-3.1-pro', displayName: 'Gemini 3.1 Pro (alias)' },
          {
            name: 'gemini-3.1-pro-preview',
            displayName: 'Gemini 3.1 Pro Preview',
          },
          { name: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' },
          { name: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash' },
          {
            name: 'gemini-2.5-flash-lite',
            displayName: 'Gemini 2.5 Flash Lite',
          },
        ],
      },
      QWEN3_CODER: {
        provider: 'QWEN3_CODER',
        available: true,
        models: [{ name: 'qwen3-coder', displayName: 'Qwen3 Coder' }],
      },
    };
  }

  // ─── CLI Tools ─────────────────────────────────────────────

  /** Detect installed CLI tools (claude, codex, gemini, qwen3-coder) */
  async detectCliTools(): Promise<CliToolStatus[]> {
    const tools = [
      { name: 'Claude Code', command: 'claude' },
      { name: 'Codex CLI', command: 'codex' },
      { name: 'Gemini CLI', command: 'gemini' },
      { name: 'Qwen Code', command: 'qwen' },
    ];

    const results: CliToolStatus[] = [];

    for (const tool of tools) {
      try {
        const { execFile } = await import('child_process');
        const { promisify } = await import('util');
        const execFileAsync = promisify(execFile);

        const { stdout } = await execFileAsync(tool.command, ['--version'], {
          timeout: 5000,
          env: { ...process.env, PATH: process.env.PATH },
        });

        results.push({
          name: tool.name,
          command: tool.command,
          installed: true,
          version: stdout.trim().split('\n')[0],
        });
      } catch {
        // Try 'which' to at least detect if the binary exists
        try {
          const { execFile } = await import('child_process');
          const { promisify } = await import('util');
          const execFileAsync = promisify(execFile);

          await execFileAsync('which', [tool.command], { timeout: 3000 });
          results.push({
            name: tool.name,
            command: tool.command,
            installed: true,
            version: 'unknown',
          });
        } catch {
          results.push({
            name: tool.name,
            command: tool.command,
            installed: false,
          });
        }
      }
    }

    return results;
  }
}
