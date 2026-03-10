import { Injectable, Logger } from '@nestjs/common';
import { CliBaseProvider } from './cli-base.provider';
import { LlmCompletionOptions } from '../llm.interfaces';

/**
 * Claude Code CLI provider.
 *
 * Uses `claude -p` (print mode) for non-interactive execution.
 * Supports: --model, --system-prompt, --allowedTools, --permission-mode, -C (cwd).
 *
 * Models: opus (Opus 4.6), sonnet (Sonnet 4.6), haiku (Haiku 4.5)
 * Auth: Claude Max/Pro subscription
 */
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

    // System prompt via CLI flag (cleaner than mixing into stdin)
    const systemPrompt = this.getSystemPrompt(options);
    if (systemPrompt) {
      args.push('--system-prompt', systemPrompt);
    }

    // Working directory
    if (options.cwd) {
      args.push('--add-dir', options.cwd);
    }

    // Allow tools for autonomous coding tasks
    // Default: all tools. Can be restricted via options.tools names.
    if (options.tools && options.tools.length > 0) {
      const toolNames = options.tools.map((t) => t.name).join(',');
      args.push('--allowedTools', toolNames);
    }

    // Bypass permission prompts for pipeline automation
    args.push('--permission-mode', 'bypassPermissions');

    return args;
  }
}
