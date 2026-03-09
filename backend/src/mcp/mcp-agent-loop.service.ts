import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../llm/llm.service';
import { LlmMessage } from '../llm/llm.interfaces';
import { McpClientService } from './mcp-client.service';
import { McpAgentLoopOptions, McpAgentLoopResult } from './mcp.interfaces';

const DEFAULT_MAX_ITERATIONS = 30;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

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
    const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
        // Timeout check
        if (Date.now() - start > timeoutMs) {
          this.logger.warn(`Agent loop timeout after ${iterations} iterations`);
          return this.buildResult(finalContent, iterations, totalToolCalls, start, 'timeout');
        }

        iterations++;
        this.logger.debug(`Agent loop iteration ${iterations}/${maxIterations}`);

        // Call LLM with tools
        const result = await this.llmService.complete({
          provider: options.provider,
          model: options.model,
          messages,
          tools: tools.length > 0 ? tools : undefined,
          temperature: options.temperature,
          maxTokens: options.maxTokens,
          timeoutMs: Math.max(timeoutMs - (Date.now() - start), 30_000), // Remaining time, min 30s
        });

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
            this.logger.debug(`Executing tool: ${toolCall.name}(${JSON.stringify(toolCall.arguments).substring(0, 200)})`);

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
          return this.buildResult(finalContent, iterations, totalToolCalls, start, 'complete');
        }

        // Case 3: Empty response — error
        this.logger.warn(`Agent loop: LLM returned empty response on iteration ${iterations}`);
        return this.buildResult('', iterations, totalToolCalls, start, 'error');
      }

      // Max iterations reached
      this.logger.warn(`Agent loop hit max iterations (${maxIterations})`);
      return this.buildResult(finalContent, iterations, totalToolCalls, start, 'max_iterations');

    } catch (err) {
      this.logger.error(`Agent loop error: ${err.message}`, err.stack);
      return this.buildResult('', 0, 0, start, 'error');

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
  ): McpAgentLoopResult {
    return {
      content,
      iterations,
      toolCallsExecuted,
      durationMs: Date.now() - startMs,
      finishReason,
    };
  }
}
