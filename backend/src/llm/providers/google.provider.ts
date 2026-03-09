import { Injectable, Logger } from '@nestjs/common';
import { SystemSettingsService } from '../../settings/system-settings.service';
import {
  LlmStreamingProvider,
  LlmCompletionOptions,
  LlmCompletionResult,
  LlmStreamChunk,
} from '../llm.interfaces';

@Injectable()
export class GoogleProvider implements LlmStreamingProvider {
  readonly providerType = 'GOOGLE';
  private readonly logger = new Logger(GoogleProvider.name);

  constructor(private readonly settings: SystemSettingsService) {}

  async complete(options: LlmCompletionOptions): Promise<LlmCompletionResult> {
    const apiKey = this.settings.googleApiKey;
    if (!apiKey) {
      this.logger.error('Google AI API key not configured');
      return { content: '', finishReason: 'error' };
    }

    const systemMessage = options.messages.find((m) => m.role === 'system');
    const conversationMessages = options.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

    const body: Record<string, unknown> = {
      contents: conversationMessages,
      ...(systemMessage && {
        systemInstruction: { parts: [{ text: systemMessage.content }] },
      }),
      generationConfig: {
        ...(options.temperature !== undefined && {
          temperature: options.temperature,
        }),
        ...(options.maxTokens !== undefined && {
          maxOutputTokens: options.maxTokens,
        }),
      },
    };

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${options.model}:generateContent?key=${apiKey}`;

    this.logger.debug(
      `Google AI request: model=${options.model}, messages=${conversationMessages.length}`,
    );

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`Google AI error ${response.status}: ${errorText}`);
        return { content: '', finishReason: 'error' };
      }

      const data = await response.json();
      const candidate = data.candidates?.[0];
      const textPart = candidate?.content?.parts?.find(
        (p: { text?: string }) => p.text,
      );

      return {
        content: textPart?.text ?? '',
        finishReason:
          candidate?.finishReason === 'STOP' ? 'stop' : 'length',
        usage: data.usageMetadata
          ? {
              promptTokens: data.usageMetadata.promptTokenCount ?? 0,
              completionTokens:
                data.usageMetadata.candidatesTokenCount ?? 0,
              totalTokens: data.usageMetadata.totalTokenCount ?? 0,
            }
          : undefined,
      };
    } catch (err) {
      this.logger.error(`Google AI request failed: ${err.message}`);
      return { content: '', finishReason: 'error' };
    }
  }

  async *streamComplete(options: LlmCompletionOptions): AsyncGenerator<LlmStreamChunk> {
    const apiKey = this.settings.googleApiKey;
    if (!apiKey) {
      this.logger.error('Google AI API key not configured');
      yield { content: '', done: true };
      return;
    }

    const systemMessage = options.messages.find((m) => m.role === 'system');
    const conversationMessages = options.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

    const body: Record<string, unknown> = {
      contents: conversationMessages,
      ...(systemMessage && {
        systemInstruction: { parts: [{ text: systemMessage.content }] },
      }),
      generationConfig: {
        ...(options.temperature !== undefined && { temperature: options.temperature }),
        ...(options.maxTokens !== undefined && { maxOutputTokens: options.maxTokens }),
      },
    };

    // Google uses streamGenerateContent endpoint
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${options.model}:streamGenerateContent?alt=sse&key=${apiKey}`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`Google stream error ${response.status}: ${errorText}`);
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

          try {
            const event = JSON.parse(data);
            const text = event.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) {
              yield { content: text, done: false };
            }
          } catch { /* skip */ }
        }
      }
      yield { content: '', done: true };
    } catch (err) {
      this.logger.error(`Google stream failed: ${err.message}`);
      yield { content: '', done: true };
    }
  }
}
