import { Injectable, Logger } from '@nestjs/common';
import { CliBaseProvider } from './cli-base.provider';
import { LlmCompletionOptions } from '../llm.interfaces';

/**
 * Codex CLI provider (OpenAI).
 *
 * Uses `codex exec` for non-interactive execution with full-auto sandbox.
 * Supports: --model, -C (cwd), --full-auto, --json output.
 *
 * Special mode: `codex review` for code review tasks.
 *
 * Models: gpt-5.4, gpt-5.3-codex, codex-mini-latest
 * Auth: ChatGPT Pro subscription
 */
@Injectable()
export class CodexCliProvider extends CliBaseProvider {
  readonly providerType = 'CODEX_CLI';
  protected readonly command = 'codex';
  protected readonly logger = new Logger(CodexCliProvider.name);

  protected buildArgs(options: LlmCompletionOptions): string[] {
    const args = [
      'exec',
      '--full-auto', // Auto-approve tools within sandbox
      '--ephemeral', // Don't persist session files
    ];

    if (options.model) {
      args.push('--model', options.model);
    }

    // Working directory
    if (options.cwd) {
      args.push('-C', options.cwd);
    }

    return args;
  }
}
