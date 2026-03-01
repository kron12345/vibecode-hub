import { Injectable, Logger } from '@nestjs/common';
import { CliBaseProvider } from './cli-base.provider';
import { LlmCompletionOptions } from '../llm.interfaces';

@Injectable()
export class QwenCoderProvider extends CliBaseProvider {
  readonly providerType = 'QWEN3_CODER';
  protected readonly command = 'qwen';
  protected readonly logger = new Logger(QwenCoderProvider.name);

  protected buildArgs(options: LlmCompletionOptions): string[] {
    const args: string[] = [];
    if (options.model) {
      args.push('--model', options.model);
    }
    return args;
  }
}
