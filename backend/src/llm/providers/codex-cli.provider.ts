import { Injectable, Logger } from '@nestjs/common';
import { CliBaseProvider } from './cli-base.provider';
import { LlmCompletionOptions } from '../llm.interfaces';

@Injectable()
export class CodexCliProvider extends CliBaseProvider {
  readonly providerType = 'CODEX_CLI';
  protected readonly command = 'codex';
  protected readonly logger = new Logger(CodexCliProvider.name);

  protected buildArgs(options: LlmCompletionOptions): string[] {
    const args = ['--quiet'];
    if (options.model) {
      args.push('--model', options.model);
    }
    return args;
  }
}
