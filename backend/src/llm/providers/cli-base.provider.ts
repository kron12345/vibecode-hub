import { Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import {
  LlmProvider,
  LlmCompletionOptions,
  LlmCompletionResult,
} from '../llm.interfaces';

/**
 * Base class for CLI-based LLM providers (Claude Code, Codex CLI, Gemini CLI, Qwen Code).
 * Executes the CLI tool as a subprocess with the prompt via stdin.
 *
 * CLI tools handle their own tool-use loops internally — we just send the prompt
 * and collect the final output. This is fundamentally different from API providers
 * where the Hub manages the tool-call loop.
 */
export abstract class CliBaseProvider implements LlmProvider {
  abstract readonly providerType: string;
  protected abstract readonly command: string;
  protected abstract readonly logger: Logger;

  protected abstract buildArgs(options: LlmCompletionOptions): string[];

  /**
   * Resolve the system prompt from the messages array.
   * Convention: first message with role='system' is the system prompt.
   */
  protected getSystemPrompt(options: LlmCompletionOptions): string | undefined {
    const systemMsg = options.messages.find((m) => m.role === 'system');
    return systemMsg?.content;
  }

  /**
   * Build the user prompt from non-system messages.
   */
  protected getUserPrompt(options: LlmCompletionOptions): string {
    return options.messages
      .filter((m) => m.role !== 'system')
      .map((m) => m.content)
      .join('\n\n');
  }

  async complete(options: LlmCompletionOptions): Promise<LlmCompletionResult> {
    const args = this.buildArgs(options);

    // User prompt is sent via stdin (or as positional arg, depending on CLI)
    const prompt = this.getUserPrompt(options);

    this.logger.log(`CLI request: ${this.command} ${args.join(' ')} (${prompt.length} chars)`);

    return new Promise((resolve) => {
      const child = execFile(
        this.command,
        args,
        {
          timeout: 0, // No timeout — CLI tools get unlimited time
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
