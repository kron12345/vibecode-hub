import { Injectable, Logger } from '@nestjs/common';
import { CliBaseProvider } from './cli-base.provider';
import { LlmCompletionOptions } from '../llm.interfaces';

/**
 * Gemini CLI provider (Google).
 *
 * Uses `gemini -p` (headless mode) for non-interactive execution.
 * Supports: --model, --yolo (auto-approve all tools), --sandbox,
 *           --output-format json, @file.png for image input.
 *
 * Models: gemini-3.1-pro (alias), gemini-3.1-pro-preview, gemini-2.5-pro, gemini-2.5-flash
 * Auth: Google Account (free tier) or Google One AI Premium (higher limits)
 *
 * Multimodal: Reference images via @path in the prompt text, e.g.:
 *   "Analyze this screenshot: @./screenshots/page.png"
 */
@Injectable()
export class GeminiCliProvider extends CliBaseProvider {
  readonly providerType = 'GEMINI_CLI';
  protected readonly command = 'gemini';
  protected readonly logger = new Logger(GeminiCliProvider.name);

  private resolveModel(model?: string): string {
    const raw = (model ?? '').trim();
    if (!raw) return 'gemini-3.1-pro-preview';

    const normalized = raw.toLowerCase().replace(/\s+/g, '-');
    const aliases: Record<string, string> = {
      'gemini-3.1-pro': 'gemini-3.1-pro-preview',
      'gemini-3-pro': 'gemini-3.1-pro-preview',
      'gemini-3-pro-preview': 'gemini-3.1-pro-preview',
      'gemini-3.1-pro-preview': 'gemini-3.1-pro-preview',
    };

    return aliases[normalized] ?? normalized;
  }

  protected buildArgs(options: LlmCompletionOptions): string[] {
    // Gemini uses -p "prompt" flag — prompt goes as arg, not stdin
    const userPrompt = this.getUserPrompt(options);

    const args: string[] = [];
    const resolvedModel = this.resolveModel(options.model);
    args.push('--model', resolvedModel);

    // Auto-approve all tool calls for pipeline automation
    args.push('--yolo');

    // Sandbox for safety even in yolo mode
    args.push('--sandbox');

    // Output format
    args.push('--output-format', 'text');

    // Prompt via -p flag (headless mode)
    // Prepend system prompt if present
    const systemPrompt = this.getSystemPrompt(options);
    const fullPrompt = systemPrompt
      ? `${systemPrompt}\n\n---\n\n${userPrompt}`
      : userPrompt;
    args.push('-p', fullPrompt);

    return args;
  }

  /**
   * Override: Gemini sends prompt via -p flag, not stdin.
   */
  async complete(options: LlmCompletionOptions) {
    const args = this.buildArgs(options);
    const timeoutMs = options.timeoutMs ?? CliBaseProvider.DEFAULT_TIMEOUT_MS;
    const selectedModel = this.resolveModel(options.model);

    if (options.model && selectedModel !== options.model) {
      this.logger.log(
        `Gemini CLI model alias applied: ${options.model} -> ${selectedModel}`,
      );
    }

    this.logger.log(
      `Gemini CLI request: model=${selectedModel}, timeout=${Math.round(timeoutMs / 1000)}s`,
    );

    return new Promise<import('../llm.interfaces').LlmCompletionResult>(
      (resolve) => {
        const { execFile } = require('child_process');

        const child = execFile(
          this.command,
          args,
          {
            timeout: timeoutMs,
            maxBuffer: 10 * 1024 * 1024,
            env: { ...process.env },
            ...(options.cwd && { cwd: options.cwd }),
          },
          (error: any, stdout: string, stderr: string) => {
            if (error) {
              this.logger.error(`Gemini CLI failed: ${error.message}`);
              if (stderr) {
                this.logger.debug(`stderr: ${stderr.substring(0, 500)}`);
              }
              const isTimeout = error.killed || error.signal === 'SIGTERM';
              const stderrSnippet = stderr?.trim()
                ? ` — stderr: ${stderr.trim().substring(0, 300)}`
                : '';
              resolve({
                content: (stdout || '').trim(),
                finishReason: 'error',
                errorMessage: isTimeout
                  ? `Gemini CLI timed out after ${Math.round(timeoutMs / 1000)}s${stderrSnippet}`
                  : `Gemini CLI failed: ${error.message}${stderrSnippet}`,
              });
              return;
            }

            resolve({
              content: stdout.trim(),
              finishReason: 'stop',
            });
          },
        );

        // Gemini uses -p flag, no stdin needed. Close stdin immediately.
        if (child.stdin) {
          child.stdin.end();
        }
      },
    );
  }
}
