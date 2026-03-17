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
   * Build the full prompt for CLI tools.
   * Combines system prompt + user messages into one string.
   * CLI tools don't have separate system/user message support,
   * so the system prompt is prepended as context.
   */
  protected getUserPrompt(options: LlmCompletionOptions): string {
    const systemPrompt = this.getSystemPrompt(options);
    const userMessages = options.messages
      .filter((m) => m.role !== 'system')
      .map((m) => getTextContent(m.content))
      .join('\n\n');

    // Prepend system prompt so CLI tools see the JSON format requirements,
    // Expectation Pattern rules, severity definitions, etc.
    if (systemPrompt) {
      return `${systemPrompt}\n\n---\n\n${userMessages}`;
    }
    return userMessages;
  }

  /** Default timeout: 90 minutes. CLI tasks that need more should pass timeoutMs. */
  static readonly DEFAULT_TIMEOUT_MS = 90 * 60 * 1000;

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
            const isTimeout =
              error.killed || (error as any).signal === 'SIGTERM';
            const stderrText = (stderr || '').trim();
            const stderrSnippet = stderrText
              ? ` — stderr: ${stderrText.substring(0, 300)}`
              : '';
            if (isTimeout) {
              this.logger.warn(
                `CLI ${this.command} killed after ${Math.round(timeoutMs / 1000)}s timeout`,
              );
            } else {
              this.logger.error(`CLI ${this.command} failed: ${error.message}`);
            }
            if (stderr) {
              this.logger.debug(`stderr: ${stderr.substring(0, 500)}`);
            }
            const reason = isTimeout
              ? `CLI ${this.command} timed out after ${Math.round(timeoutMs / 1000)}s${stderrSnippet}`
              : `CLI ${this.command} failed: ${error.message}${stderrSnippet}`;
            resolve({
              content: (stdout || '').trim(),
              finishReason: 'error',
              errorMessage: reason,
            });
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
