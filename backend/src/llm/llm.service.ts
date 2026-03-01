import { Injectable, Logger } from '@nestjs/common';
import {
  LlmProvider,
  LlmCompletionOptions,
  LlmCompletionResult,
  LlmStreamChunk,
} from './llm.interfaces';
import { OllamaProvider } from './providers/ollama.provider';
import { AnthropicProvider } from './providers/anthropic.provider';
import { OpenAIProvider } from './providers/openai.provider';
import { GoogleProvider } from './providers/google.provider';
import { ClaudeCodeProvider } from './providers/claude-code.provider';
import { CodexCliProvider } from './providers/codex-cli.provider';
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
    qwenCoder: QwenCoderProvider,
  ) {
    this.providers.set('OLLAMA', ollama);
    this.providers.set('ANTHROPIC', anthropic);
    this.providers.set('OPENAI', openai);
    this.providers.set('GOOGLE', google);
    this.providers.set('CLAUDE_CODE', claudeCode);
    this.providers.set('CODEX_CLI', codexCli);
    this.providers.set('QWEN3_CODER', qwenCoder);
  }

  /** Send a completion request to the configured provider */
  async complete(options: LlmCompletionOptions): Promise<LlmCompletionResult> {
    const provider = this.providers.get(options.provider);
    if (!provider) {
      this.logger.error(`Unknown LLM provider: ${options.provider}`);
      return { content: '', finishReason: 'error' };
    }

    this.logger.log(
      `LLM request → ${options.provider}/${options.model} (${options.messages.length} messages)`,
    );

    const result = await provider.complete(options);

    if (result.finishReason === 'error') {
      this.logger.warn(
        `LLM request failed: ${options.provider}/${options.model}`,
      );
    } else {
      this.logger.debug(
        `LLM response: ${result.content.length} chars, reason=${result.finishReason}`,
      );
    }

    return result;
  }

  /** Streaming fallback — returns single chunk for non-streaming providers */
  async *completeStream(
    options: LlmCompletionOptions,
  ): AsyncIterable<LlmStreamChunk> {
    const result = await this.complete(options);
    yield { content: result.content, done: true };
  }

  /** Check if a provider is registered */
  hasProvider(providerType: string): boolean {
    return this.providers.has(providerType);
  }
}
