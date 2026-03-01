import { Injectable, Logger } from '@nestjs/common';
import { SystemSettingsService } from '../../settings/system-settings.service';
import {
  LlmProvider,
  LlmCompletionOptions,
  LlmCompletionResult,
} from '../llm.interfaces';

@Injectable()
export class AnthropicProvider implements LlmProvider {
  readonly providerType = 'ANTHROPIC';
  private readonly logger = new Logger(AnthropicProvider.name);

  constructor(private readonly settings: SystemSettingsService) {}

  async complete(options: LlmCompletionOptions): Promise<LlmCompletionResult> {
    const apiKey = this.settings.anthropicApiKey;
    if (!apiKey) {
      this.logger.error('Anthropic API key not configured');
      return { content: '', finishReason: 'error' };
    }

    const systemMessage = options.messages.find((m) => m.role === 'system');
    const conversationMessages = options.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));

    const body: Record<string, unknown> = {
      model: options.model,
      messages: conversationMessages,
      max_tokens: options.maxTokens ?? 4096,
      ...(systemMessage && { system: systemMessage.content }),
      ...(options.temperature !== undefined && {
        temperature: options.temperature,
      }),
    };

    this.logger.debug(
      `Anthropic request: model=${options.model}, messages=${conversationMessages.length}`,
    );

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`Anthropic error ${response.status}: ${errorText}`);
        return { content: '', finishReason: 'error' };
      }

      const data = await response.json();
      const textBlock = data.content?.find(
        (b: { type: string }) => b.type === 'text',
      );

      return {
        content: textBlock?.text ?? '',
        finishReason: data.stop_reason === 'end_turn' ? 'stop' : 'length',
        usage: data.usage
          ? {
              promptTokens: data.usage.input_tokens,
              completionTokens: data.usage.output_tokens,
              totalTokens:
                data.usage.input_tokens + data.usage.output_tokens,
            }
          : undefined,
      };
    } catch (err) {
      if (err.name === 'AbortError') {
        this.logger.error('Anthropic request timed out after 120s');
      } else {
        this.logger.error(`Anthropic request failed: ${err.message}`);
      }
      return { content: '', finishReason: 'error' };
    } finally {
      clearTimeout(timeout);
    }
  }
}
