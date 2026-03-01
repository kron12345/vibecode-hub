import { Injectable, Logger } from '@nestjs/common';
import { SystemSettingsService } from '../../settings/system-settings.service';
import {
  LlmProvider,
  LlmCompletionOptions,
  LlmCompletionResult,
} from '../llm.interfaces';

@Injectable()
export class OpenAIProvider implements LlmProvider {
  readonly providerType = 'OPENAI';
  private readonly logger = new Logger(OpenAIProvider.name);

  constructor(private readonly settings: SystemSettingsService) {}

  async complete(options: LlmCompletionOptions): Promise<LlmCompletionResult> {
    const apiKey = this.settings.openaiApiKey;
    if (!apiKey) {
      this.logger.error('OpenAI API key not configured');
      return { content: '', finishReason: 'error' };
    }

    const messages = options.messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const body: Record<string, unknown> = {
      model: options.model,
      messages,
      ...(options.maxTokens !== undefined && { max_tokens: options.maxTokens }),
      ...(options.temperature !== undefined && {
        temperature: options.temperature,
      }),
    };

    this.logger.debug(
      `OpenAI request: model=${options.model}, messages=${messages.length}`,
    );

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);

    try {
      const response = await fetch(
        'https://api.openai.com/v1/chat/completions',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`OpenAI error ${response.status}: ${errorText}`);
        return { content: '', finishReason: 'error' };
      }

      const data = await response.json();
      const choice = data.choices?.[0];

      return {
        content: choice?.message?.content ?? '',
        finishReason:
          choice?.finish_reason === 'stop' ? 'stop' : 'length',
        usage: data.usage
          ? {
              promptTokens: data.usage.prompt_tokens,
              completionTokens: data.usage.completion_tokens,
              totalTokens: data.usage.total_tokens,
            }
          : undefined,
      };
    } catch (err) {
      if (err.name === 'AbortError') {
        this.logger.error('OpenAI request timed out after 120s');
      } else {
        this.logger.error(`OpenAI request failed: ${err.message}`);
      }
      return { content: '', finishReason: 'error' };
    } finally {
      clearTimeout(timeout);
    }
  }
}
