import { Injectable, Logger } from '@nestjs/common';
import { CliBaseProvider } from './cli-base.provider';
import { LlmCompletionOptions } from '../llm.interfaces';

@Injectable()
export class ClaudeCodeProvider extends CliBaseProvider {
  readonly providerType = 'CLAUDE_CODE';
  protected readonly command = 'claude';
  protected readonly logger = new Logger(ClaudeCodeProvider.name);

  protected buildArgs(options: LlmCompletionOptions): string[] {
    const args = ['-p', '--output-format', 'text'];
    if (options.model) {
      args.push('--model', options.model);
    }
    return args;
  }
}
