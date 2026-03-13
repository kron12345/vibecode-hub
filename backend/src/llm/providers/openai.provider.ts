import { Injectable, Logger } from '@nestjs/common';
import { SystemSettingsService } from '../../settings/system-settings.service';
import {
  LlmStreamingProvider,
  LlmCompletionOptions,
  LlmCompletionResult,
  LlmStreamChunk,
  LlmContentPart,
} from '../llm.interfaces';

@Injectable()
export class OpenAIProvider implements LlmStreamingProvider {
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
      content: this.formatContent(m.content),
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
      this.logger.error(`OpenAI request failed: ${err.message}`);
      return { content: '', finishReason: 'error' };
    }
  }

  async *streamComplete(options: LlmCompletionOptions): AsyncGenerator<LlmStreamChunk> {
    const apiKey = this.settings.openaiApiKey;
    if (!apiKey) {
      this.logger.error('OpenAI API key not configured');
      yield { content: '', done: true };
      return;
    }

    const messages = options.messages.map((m) => ({ role: m.role, content: this.formatContent(m.content) }));

    const body: Record<string, unknown> = {
      model: options.model,
      messages,
      stream: true,
      ...(options.maxTokens !== undefined && { max_tokens: options.maxTokens }),
      ...(options.temperature !== undefined && { temperature: options.temperature }),
    };

    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`OpenAI stream error ${response.status}: ${errorText}`);
        yield { content: '', done: true };
        return;
      }

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
            const token = event.choices?.[0]?.delta?.content;
            if (token) {
              yield { content: token, done: false };
            }
          } catch { /* skip */ }
        }
      }
      yield { content: '', done: true };
    } catch (err) {
      this.logger.error(`OpenAI stream failed: ${err.message}`);
      yield { content: '', done: true };
    }
  }

  /**
   * Convert LlmMessage content to OpenAI API format.
   * String → string, LlmContentPart[] → OpenAI content array with image_url.
   */
  private formatContent(content: string | LlmContentPart[]): unknown {
    if (typeof content === 'string') return content;
    return content.map((part) => {
      if (part.type === 'text') return { type: 'text', text: part.text };
      return {
        type: 'image_url',
        image_url: {
          url: `data:${part.mediaType};base64,${part.base64}`,
        },
      };
    });
  }
}
