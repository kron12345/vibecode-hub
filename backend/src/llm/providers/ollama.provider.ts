import { Injectable, Logger } from '@nestjs/common';
import { SystemSettingsService } from '../../settings/system-settings.service';
import {
  LlmProvider,
  LlmCompletionOptions,
  LlmCompletionResult,
} from '../llm.interfaces';

@Injectable()
export class OllamaProvider implements LlmProvider {
  readonly providerType = 'OLLAMA';
  private readonly logger = new Logger(OllamaProvider.name);

  constructor(private readonly settings: SystemSettingsService) {}

  async complete(options: LlmCompletionOptions): Promise<LlmCompletionResult> {
    const baseUrl = this.settings.ollamaUrl;
    const url = `${baseUrl}/api/chat`;

    const body = {
      model: options.model,
      messages: options.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      stream: false,
      options: {
        ...(options.temperature !== undefined && {
          temperature: options.temperature,
        }),
        ...(options.maxTokens !== undefined && {
          num_predict: options.maxTokens,
        }),
      },
    };

    this.logger.debug(
      `Ollama request: model=${options.model}, messages=${options.messages.length}`,
    );

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`Ollama error ${response.status}: ${errorText}`);
        return {
          content: '',
          finishReason: 'error',
        };
      }

      const data = await response.json();

      return {
        content: data.message?.content ?? '',
        finishReason: data.done ? 'stop' : 'length',
        usage: data.eval_count
          ? {
              promptTokens: data.prompt_eval_count ?? 0,
              completionTokens: data.eval_count ?? 0,
              totalTokens:
                (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
            }
          : undefined,
      };
    } catch (err) {
      if (err.name === 'AbortError') {
        this.logger.error('Ollama request timed out after 120s');
      } else {
        this.logger.error(`Ollama request failed: ${err.message}`);
      }
      return { content: '', finishReason: 'error' };
    } finally {
      clearTimeout(timeout);
    }
  }
}
