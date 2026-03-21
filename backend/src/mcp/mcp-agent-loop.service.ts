import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../llm/llm.service';
import { LlmMessage } from '../llm/llm.interfaces';
import { McpClientService } from './mcp-client.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../settings/system-settings.service';
import { McpAgentLoopOptions, McpAgentLoopResult } from './mcp.interfaces';

const FALLBACK_MAX_ITERATIONS = 30;

/**
 * Generic MCP Agent Loop.
 *
 * Orchestrates: LLM call → tool_calls → MCP execution → results back to LLM → repeat.
 * Stops when the LLM produces a final text response (no more tool calls),
 * or when max iterations / timeout is reached.
 */
@Injectable()
export class McpAgentLoopService {
  private readonly logger = new Logger(McpAgentLoopService.name);

  constructor(
    private readonly llmService: LlmService,
    private readonly mcpClient: McpClientService,
    private readonly prisma: PrismaService,
    private readonly settings: SystemSettingsService,
  ) {}

  /**
   * Run the agent loop.
   *
   * 1. Starts MCP servers from config
   * 2. Discovers available tools
   * 3. Sends prompt + tools to LLM
   * 4. If LLM returns tool_calls → execute via MCP → feed results back
   * 5. Repeat until LLM gives final text or limits reached
   * 6. Cleans up MCP servers
   */
  async run(options: McpAgentLoopOptions): Promise<McpAgentLoopResult> {
    const start = Date.now();
    const pipelineCfg = this.settings.getPipelineConfig();
    const maxIterations =
      options.maxIterations ??
      pipelineCfg.mcpMaxIterations ??
      FALLBACK_MAX_ITERATIONS;
    const llmTimeoutMs =
      options.timeoutMs ?? (pipelineCfg.cliTimeoutMinutes ?? 90) * 60 * 1000;
    let sessionId: string | null = null;

    try {
      // Start MCP servers
      sessionId = await this.mcpClient.createSession(options.mcpServers);
      const tools = this.mcpClient.getTools(sessionId);

      this.logger.log(
        `Agent loop starting — ${tools.length} tools, model=${options.model}, maxIter=${maxIterations}`,
      );

      // Build initial messages
      const messages: LlmMessage[] = [
        { role: 'system', content: options.systemPrompt },
        { role: 'user', content: options.userPrompt },
      ];

      let iterations = 0;
      let totalToolCalls = 0;
      let finalContent = '';

      // Agent loop
      while (iterations < maxIterations) {
        iterations++;
        this.logger.debug(
          `Agent loop iteration ${iterations}/${maxIterations}`,
        );

        // Write activity log every 5 iterations to prevent stuck-task cleanup
        if (options.agentTaskId && iterations % 5 === 1) {
          this.prisma.agentLog
            .create({
              data: {
                agentTaskId: options.agentTaskId,
                level: 'INFO',
                message: `MCP agent loop active — iteration ${iterations}/${maxIterations}, ${totalToolCalls} tool calls`,
              },
            })
            .catch((err) => { this.logger.debug(`Activity log write failed (non-critical): ${err.message}`); });
        }

        // Call LLM with tools
        const result = await this.llmService.complete({
          provider: options.provider,
          model: options.model,
          messages,
          tools: tools.length > 0 ? tools : undefined,
          temperature: options.temperature,
          maxTokens: options.maxTokens,
          cwd: options.cwd,
          timeoutMs: llmTimeoutMs,
        });

        if (result.finishReason === 'error') {
          const errorMessage =
            result.errorMessage || 'LLM provider call failed';
          this.logger.warn(
            `Agent loop LLM error on iteration ${iterations}: ${errorMessage}`,
          );
          return this.buildResult(
            '',
            iterations,
            totalToolCalls,
            start,
            'error',
            errorMessage,
          );
        }

        options.onIteration?.(iterations, result.content);

        // Case 1: LLM returned tool calls — execute them
        if (result.finishReason === 'tool_calls' && result.toolCalls?.length) {
          // Add assistant message with tool calls to history
          messages.push({
            role: 'assistant',
            content: result.content || '',
            toolCalls: result.toolCalls,
          });

          // Execute each tool call
          for (const toolCall of result.toolCalls) {
            this.logger.debug(
              `Executing tool: ${toolCall.name}(${JSON.stringify(toolCall.arguments).substring(0, 200)})`,
            );

            const toolResult = await this.mcpClient.callTool(
              sessionId,
              toolCall.name,
              toolCall.arguments,
            );

            totalToolCalls++;
            options.onToolCall?.(toolCall.name, toolCall.arguments, toolResult);

            // Add tool result to message history
            messages.push({
              role: 'tool',
              content: toolResult,
              toolCallId: toolCall.id,
            });
          }

          // Continue loop — LLM will see tool results and decide next step
          continue;
        }

        // Case 2: LLM returned final text content — done!
        if (result.content) {
          finalContent = result.content;
          this.logger.log(
            `Agent loop complete after ${iterations} iterations, ${totalToolCalls} tool calls, ${result.content.length} chars`,
          );
          return this.buildResult(
            finalContent,
            iterations,
            totalToolCalls,
            start,
            'complete',
          );
        }

        // Case 3: Empty response — if we already executed tools, treat as "complete" (files were written)
        if (totalToolCalls > 0) {
          this.logger.warn(
            `Agent loop: LLM returned empty response on iteration ${iterations} — but ${totalToolCalls} tools were executed, treating as complete`,
          );
          return this.buildResult(
            `(Agent completed ${totalToolCalls} tool operations)`,
            iterations,
            totalToolCalls,
            start,
            'complete',
          );
        }
        this.logger.warn(
          `Agent loop: LLM returned empty response on iteration ${iterations}`,
        );
        return this.buildResult(
          '',
          iterations,
          totalToolCalls,
          start,
          'error',
          'LLM returned empty response',
        );
      }

      // Max iterations reached
      this.logger.warn(`Agent loop hit max iterations (${maxIterations})`);
      return this.buildResult(
        finalContent,
        iterations,
        totalToolCalls,
        start,
        'max_iterations',
      );
    } catch (err) {
      this.logger.error(`Agent loop error: ${err.message}`, err.stack);
      return this.buildResult('', 0, 0, start, 'error', err.message);
    } finally {
      // Always clean up MCP servers
      if (sessionId) {
        await this.mcpClient.destroySession(sessionId);
      }
    }
  }

  private buildResult(
    content: string,
    iterations: number,
    toolCallsExecuted: number,
    startMs: number,
    finishReason: McpAgentLoopResult['finishReason'],
    errorMessage?: string,
  ): McpAgentLoopResult {
    return {
      content,
      iterations,
      toolCallsExecuted,
      durationMs: Date.now() - startMs,
      finishReason,
      ...(errorMessage && { errorMessage }),
    };
  }
}
