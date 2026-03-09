import { Injectable, Logger } from '@nestjs/common';
import { SystemSettingsService } from '../../settings/system-settings.service';
import {
  LlmStreamingProvider,
  LlmCompletionOptions,
  LlmCompletionResult,
  LlmStreamChunk,
} from '../llm.interfaces';

@Injectable()
export class AnthropicProvider implements LlmStreamingProvider {
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

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
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
      this.logger.error(`Anthropic request failed: ${err.message}`);
      return { content: '', finishReason: 'error' };
    }
  }

  async *streamComplete(options: LlmCompletionOptions): AsyncGenerator<LlmStreamChunk> {
    const apiKey = this.settings.anthropicApiKey;
    if (!apiKey) {
      this.logger.error('Anthropic API key not configured');
      yield { content: '', done: true };
      return;
    }

    const systemMessage = options.messages.find((m) => m.role === 'system');
    const conversationMessages = options.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));

    const body: Record<string, unknown> = {
      model: options.model,
      messages: conversationMessages,
      max_tokens: options.maxTokens ?? 4096,
      stream: true,
      ...(systemMessage && { system: systemMessage.content }),
      ...(options.temperature !== undefined && { temperature: options.temperature }),
    };

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`Anthropic stream error ${response.status}: ${errorText}`);
        yield { content: '', done: true };
        return;
      }

      yield* this.parseSSE(response);
    } catch (err) {
      this.logger.error(`Anthropic stream failed: ${err.message}`);
      yield { content: '', done: true };
    }
  }

  private async *parseSSE(response: Response): AsyncGenerator<LlmStreamChunk> {
    const reader = response.body?.getReader();
    if (!reader) { yield { content: '', done: true }; return; }

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') { yield { content: '', done: true }; return; }

        try {
          const event = JSON.parse(data);
          // Anthropic streaming: content_block_delta events have delta.text
          if (event.type === 'content_block_delta' && event.delta?.text) {
            yield { content: event.delta.text, done: false };
          } else if (event.type === 'message_stop') {
            yield { content: '', done: true };
            return;
          }
        } catch { /* skip */ }
      }
    }
    yield { content: '', done: true };
  }
}
