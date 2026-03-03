import { Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import {
  LlmProvider,
  LlmCompletionOptions,
  LlmCompletionResult,
} from '../llm.interfaces';

/**
 * Base class for CLI-based LLM providers (Claude Code, Codex CLI, Qwen Code).
 * Executes the CLI tool as a subprocess with the prompt via stdin.
 */
export abstract class CliBaseProvider implements LlmProvider {
  abstract readonly providerType: string;
  protected abstract readonly command: string;
  protected abstract readonly logger: Logger;

  protected abstract buildArgs(options: LlmCompletionOptions): string[];

  async complete(options: LlmCompletionOptions): Promise<LlmCompletionResult> {
    const args = this.buildArgs(options);

    // Build prompt from messages: system prompt first, then conversation
    const prompt = options.messages.map((m) => m.content).join('\n\n');

    this.logger.debug(`CLI request: ${this.command} ${args.join(' ')}`);

    return new Promise((resolve) => {
      const child = execFile(
        this.command,
        args,
        {
          timeout: 120_000,
          maxBuffer: 10 * 1024 * 1024, // 10 MB
          env: { ...process.env },
          ...(options.cwd && { cwd: options.cwd }),
        },
        (error, stdout, stderr) => {
          if (error) {
            this.logger.error(
              `CLI ${this.command} failed: ${error.message}`,
            );
            if (stderr) {
              this.logger.debug(`stderr: ${stderr.substring(0, 500)}`);
            }
            resolve({ content: '', finishReason: 'error' });
            return;
          }

          resolve({
            content: stdout.trim(),
            finishReason: 'stop',
          });
        },
      );

      // Send prompt via stdin
      if (child.stdin) {
        child.stdin.write(prompt);
        child.stdin.end();
      }
    });
  }
}
