import { Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import {
  LlmProvider,
  LlmCompletionOptions,
  LlmCompletionResult,
  getTextContent,
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
    return systemMsg ? getTextContent(systemMsg.content) : undefined;
  }

  /**
   * Build the user prompt from non-system messages.
   * Extracts text content only (CLI tools don't support inline images).
   */
  protected getUserPrompt(options: LlmCompletionOptions): string {
    return options.messages
      .filter((m) => m.role !== 'system')
      .map((m) => getTextContent(m.content))
      .join('\n\n');
  }

  /** Default timeout: 10 minutes. CLI tasks that need more should pass timeoutMs. */
  static readonly DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

  async complete(options: LlmCompletionOptions): Promise<LlmCompletionResult> {
    const args = this.buildArgs(options);

    // User prompt is sent via stdin (or as positional arg, depending on CLI)
    const prompt = this.getUserPrompt(options);

    const timeoutMs = options.timeoutMs ?? CliBaseProvider.DEFAULT_TIMEOUT_MS;

    this.logger.log(
      `CLI request: ${this.command} ${args.join(' ')} (${prompt.length} chars, timeout ${Math.round(timeoutMs / 1000)}s)`,
    );

    return new Promise((resolve) => {
      const child = execFile(
        this.command,
        args,
        {
          timeout: timeoutMs,
          maxBuffer: 10 * 1024 * 1024, // 10 MB
          env: { ...process.env },
          ...(options.cwd && { cwd: options.cwd }),
        },
        (error, stdout, stderr) => {
          if (error) {
            const isTimeout = error.killed || (error as any).signal === 'SIGTERM';
            if (isTimeout) {
              this.logger.warn(
                `CLI ${this.command} killed after ${Math.round(timeoutMs / 1000)}s timeout`,
              );
            } else {
              this.logger.error(
                `CLI ${this.command} failed: ${error.message}`,
              );
            }
            if (stderr) {
              this.logger.debug(`stderr: ${stderr.substring(0, 500)}`);
            }
            // Return partial stdout if available (process may have produced output before timeout)
            if (stdout && stdout.trim().length > 0) {
              this.logger.log(`Returning partial output (${stdout.length} chars) despite error`);
              resolve({ content: stdout.trim(), finishReason: 'stop' });
            } else {
              resolve({ content: '', finishReason: 'error' });
            }
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
