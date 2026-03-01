import { Global, Module } from '@nestjs/common';
import { LlmService } from './llm.service';
import { OllamaProvider } from './providers/ollama.provider';
import { AnthropicProvider } from './providers/anthropic.provider';
import { OpenAIProvider } from './providers/openai.provider';
import { GoogleProvider } from './providers/google.provider';
import { ClaudeCodeProvider } from './providers/claude-code.provider';
import { CodexCliProvider } from './providers/codex-cli.provider';
import { QwenCoderProvider } from './providers/qwen-coder.provider';

@Global()
@Module({
  providers: [
    LlmService,
    OllamaProvider,
    AnthropicProvider,
    OpenAIProvider,
    GoogleProvider,
    ClaudeCodeProvider,
    CodexCliProvider,
    QwenCoderProvider,
  ],
  exports: [LlmService],
})
export class LlmModule {}
