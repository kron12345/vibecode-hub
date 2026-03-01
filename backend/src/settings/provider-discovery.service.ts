import { Injectable, Logger } from '@nestjs/common';
import { SystemSettingsService } from './system-settings.service';

export interface OllamaModel {
  name: string;
  size: number;
  modifiedAt: string;
  parameterSize?: string;
  quantization?: string;
}

export interface CliToolStatus {
  name: string;
  command: string;
  installed: boolean;
  version?: string;
}

@Injectable()
export class ProviderDiscoveryService {
  private readonly logger = new Logger(ProviderDiscoveryService.name);

  constructor(private readonly systemSettings: SystemSettingsService) {}

  /** Fetch available models from Ollama API /api/tags */
  async discoverOllamaModels(): Promise<OllamaModel[]> {
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
        size: m.size,
        modifiedAt: m.modified_at,
        parameterSize: m.details?.parameter_size,
        quantization: m.details?.quantization_level,
      }));
    } catch (e) {
      this.logger.warn(`Failed to connect to Ollama at ${ollamaUrl}: ${e.message}`);
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

  /** Detect installed CLI tools (claude, codex, qwen3-coder) */
  async detectCliTools(): Promise<CliToolStatus[]> {
    const tools = [
      { name: 'Claude Code', command: 'claude' },
      { name: 'Codex CLI', command: 'codex' },
      { name: 'Qwen3 Coder', command: 'qwen3-coder' },
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
