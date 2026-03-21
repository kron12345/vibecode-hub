import { Injectable, Logger } from '@nestjs/common';
import {
  LlmProvider,
  LlmCompletionOptions,
  LlmCompletionResult,
  LlmStreamChunk,
  isStreamingProvider,
} from './llm.interfaces';
import { OllamaProvider } from './providers/ollama.provider';
import { AnthropicProvider } from './providers/anthropic.provider';
import { OpenAIProvider } from './providers/openai.provider';
import { GoogleProvider } from './providers/google.provider';
import { ClaudeCodeProvider } from './providers/claude-code.provider';
import { CodexCliProvider } from './providers/codex-cli.provider';
import { GeminiCliProvider } from './providers/gemini-cli.provider';
import { QwenCoderProvider } from './providers/qwen-coder.provider';

@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  private readonly providers = new Map<string, LlmProvider>();

  constructor(
    ollama: OllamaProvider,
    anthropic: AnthropicProvider,
    openai: OpenAIProvider,
    google: GoogleProvider,
    claudeCode: ClaudeCodeProvider,
    codexCli: CodexCliProvider,
    geminiCli: GeminiCliProvider,
    qwenCoder: QwenCoderProvider,
  ) {
    this.providers.set('OLLAMA', ollama);
    this.providers.set('ANTHROPIC', anthropic);
    this.providers.set('OPENAI', openai);
    this.providers.set('GOOGLE', google);
    this.providers.set('CLAUDE_CODE', claudeCode);
    this.providers.set('CODEX_CLI', codexCli);
    this.providers.set('GEMINI_CLI', geminiCli);
    this.providers.set('QWEN3_CODER', qwenCoder);
  }

  /** Send a completion request to the configured provider */
  async complete(options: LlmCompletionOptions): Promise<LlmCompletionResult> {
    const provider = this.providers.get(options.provider);
    if (!provider) {
      this.logger.error(`Unknown LLM provider: ${options.provider}`);
      return {
        content: '',
        finishReason: 'error',
        errorMessage: `Unknown LLM provider: ${options.provider}`,
      };
    }

    this.logger.log(
      `LLM request → ${options.provider}/${options.model} (${options.messages.length} messages)`,
    );

    const start = Date.now();
    const result = await provider.complete(options);
    const durationMs = Date.now() - start;

    if (result.finishReason === 'error') {
      this.logger.warn(
        `LLM failed (${durationMs}ms): ${options.provider}/${options.model}${result.errorMessage ? ` — ${result.errorMessage}` : ''}`,
      );
    } else {
      this.logger.log(
        `LLM response (${durationMs}ms): ${options.provider}/${options.model} → ${result.content.length} chars, reason=${result.finishReason}`,
      );
    }

    return result;
  }

  /** Stream completion tokens — falls back to single-chunk for non-streaming providers */
  async *completeStream(
    options: LlmCompletionOptions,
  ): AsyncGenerator<LlmStreamChunk> {
    const provider = this.providers.get(options.provider);
    if (!provider) {
      this.logger.error(`Unknown LLM provider: ${options.provider}`);
      yield { content: '', done: true };
      return;
    }

    if (isStreamingProvider(provider)) {
      this.logger.log(
        `LLM stream → ${options.provider}/${options.model} (${options.messages.length} messages)`,
      );
      yield* provider.streamComplete(options);
    } else {
      // Fallback: complete then yield as single chunk
      this.logger.log(
        `LLM stream fallback → ${options.provider}/${options.model} (no streaming support)`,
      );
      const result = await provider.complete(options);
      yield { content: result.content, done: true };
    }
  }

  /** Check if a provider is registered */
  hasProvider(providerType: string): boolean {
    return this.providers.has(providerType);
  }
}
