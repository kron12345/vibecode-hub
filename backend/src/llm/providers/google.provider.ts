import { Injectable, Logger } from '@nestjs/common';
import { SystemSettingsService } from '../../settings/system-settings.service';
import {
  LlmProvider,
  LlmCompletionOptions,
  LlmCompletionResult,
} from '../llm.interfaces';

@Injectable()
export class GoogleProvider implements LlmProvider {
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
      if (err.name === 'AbortError') {
        this.logger.error('Google AI request timed out after 120s');
      } else {
        this.logger.error(`Google AI request failed: ${err.message}`);
      }
      return { content: '', finishReason: 'error' };
    } finally {
      clearTimeout(timeout);
    }
  }
}
