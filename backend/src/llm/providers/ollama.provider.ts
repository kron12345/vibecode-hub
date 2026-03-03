import { Injectable, Logger } from '@nestjs/common';
import { Agent } from 'undici';
import { SystemSettingsService } from '../../settings/system-settings.service';
import {
  LlmStreamingProvider,
  LlmCompletionOptions,
  LlmCompletionResult,
  LlmStreamChunk,
} from '../llm.interfaces';

@Injectable()
export class OllamaProvider implements LlmStreamingProvider {
  readonly providerType = 'OLLAMA';
  private readonly logger = new Logger(OllamaProvider.name);

  /**
   * Custom Undici agent with extended timeouts.
   * Default headersTimeout (300s) is too short for large models like deepseek-r1:32b
   * which need ~40s to load into VRAM + minutes to generate.
   */
  private readonly dispatcher = new Agent({
    headersTimeout: 600_000, // 10 min
    bodyTimeout: 600_000,    // 10 min
    connectTimeout: 30_000,  // 30s
  });

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
      think: false, // Disable thinking mode (qwen3.5, deepseek-r1) — we don't use the output
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

    // 10 minutes timeout — large models (deepseek-r1:32b) need time to load + generate long reviews
    const timeoutMs = 600_000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
        dispatcher: this.dispatcher,
      } as any);

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`Ollama error ${response.status}: ${errorText}`);
        return {
          content: '',
          finishReason: 'error',
        };
      }

      const data = await response.json();

      // qwen3/qwen3.5 models use a 'thinking' field for chain-of-thought.
      // Sometimes content is empty while thinking has the full reasoning.
      // If content is empty but the model produced tokens, log a warning.
      let content: string = data.message?.content ?? '';
      const thinking: string = data.message?.thinking ?? '';

      if (!content && thinking) {
        this.logger.warn(
          `Ollama returned empty content but ${thinking.length} chars of thinking — model may need /nothink suffix or think:false`,
        );
      }

      this.logger.debug(`Ollama response: ${content.length} chars, ${data.eval_count ?? 0} tokens`);

      return {
        content,
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
        this.logger.error(`Ollama request timed out after ${timeoutMs / 1000}s`);
      } else {
        this.logger.error(`Ollama request failed: ${err.message} (${err.cause?.code ?? err.code ?? 'unknown'})`);
      }
      return { content: '', finishReason: 'error' };
    } finally {
      clearTimeout(timeout);
    }
  }

  async *streamComplete(options: LlmCompletionOptions): AsyncGenerator<LlmStreamChunk> {
    const baseUrl = this.settings.ollamaUrl;
    const url = `${baseUrl}/api/chat`;

    const body = {
      model: options.model,
      messages: options.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      stream: true,
      think: false,
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
      `Ollama stream request: model=${options.model}, messages=${options.messages.length}`,
    );

    const timeoutMs = 300_000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
        dispatcher: this.dispatcher,
      } as any);

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`Ollama stream error ${response.status}: ${errorText}`);
        yield { content: '', done: true };
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        yield { content: '', done: true };
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const chunk = JSON.parse(line);
            const token = chunk.message?.content ?? '';
            if (token) {
              yield { content: token, done: false };
            }
            if (chunk.done) {
              yield { content: '', done: true };
              return;
            }
          } catch {
            // Skip malformed JSON lines
          }
        }
      }

      yield { content: '', done: true };
    } catch (err) {
      if (err.name === 'AbortError') {
        this.logger.error(`Ollama stream timed out after ${timeoutMs / 1000}s`);
      } else {
        this.logger.error(`Ollama stream failed: ${err.message}`);
      }
      yield { content: '', done: true };
    } finally {
      clearTimeout(timeout);
    }
  }
}
