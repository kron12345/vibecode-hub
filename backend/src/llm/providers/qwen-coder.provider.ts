import { Injectable, Logger } from '@nestjs/common';
import { CliBaseProvider } from './cli-base.provider';
import { LlmCompletionOptions } from '../llm.interfaces';

@Injectable()
export class QwenCoderProvider extends CliBaseProvider {
  readonly providerType = 'QWEN3_CODER';
  protected readonly command = '/home/sebastian/.npm-global/bin/qwen';
  protected readonly logger = new Logger(QwenCoderProvider.name);

  protected buildArgs(options: LlmCompletionOptions): string[] {
    const args: string[] = [
      '--openai-base-url', 'http://localhost:11434/v1',
      '--openai-api-key', 'ollama',
      '--auth-type', 'openai',
    ];
    if (options.model) {
      args.push('--model', options.model);
    }
    return args;
  }
}
