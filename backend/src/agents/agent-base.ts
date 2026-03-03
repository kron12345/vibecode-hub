import { Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../settings/system-settings.service';
import { ChatService } from '../chat/chat.service';
import { ChatGateway } from '../chat/chat.gateway';
import { LlmService } from '../llm/llm.service';
import { LlmMessage, LlmCompletionResult } from '../llm/llm.interfaces';
import { AgentRole, AgentStatus, MessageRole } from '@prisma/client';

export interface AgentContext {
  projectId: string;
  agentInstanceId: string;
  agentTaskId: string;
  chatSessionId: string;
}

/**
 * Abstract base class for all agents.
 * Provides common utilities for LLM calls, messaging, and status updates.
 */
export abstract class BaseAgent {
  abstract readonly role: AgentRole;
  protected abstract readonly logger: Logger;

  constructor(
    protected readonly prisma: PrismaService,
    protected readonly settings: SystemSettingsService,
    protected readonly chatService: ChatService,
    protected readonly chatGateway: ChatGateway,
    protected readonly llmService: LlmService,
  ) {}

  /** Get the agent role config from SystemSettings */
  protected getRoleConfig() {
    return this.settings.getAgentRoleConfig(this.role);
  }

  /** Send a message as AGENT and broadcast via WebSocket */
  protected async sendAgentMessage(
    ctx: AgentContext,
    content: string,
  ) {
    const message = await this.chatService.addMessage({
      chatSessionId: ctx.chatSessionId,
      role: MessageRole.AGENT,
      content,
      agentTaskId: ctx.agentTaskId,
    });

    this.chatGateway.emitToSession(
      ctx.chatSessionId,
      'newMessage',
      message,
    );

    return message;
  }

  /** Build LlmMessage array from chat history */
  protected async getConversationHistory(
    chatSessionId: string,
  ): Promise<LlmMessage[]> {
    const messages = await this.chatService.getMessages(chatSessionId);

    return messages.map((m) => ({
      role: this.mapRole(m.role),
      content: m.content,
    }));
  }

  /** Call the LLM with the configured provider/model for this role */
  protected async callLlm(
    messages: LlmMessage[],
    overrides?: { temperature?: number; maxTokens?: number },
  ) {
    const config = this.getRoleConfig();

    return this.llmService.complete({
      provider: config.provider,
      model: config.model,
      messages,
      temperature: overrides?.temperature ?? config.parameters.temperature,
      maxTokens: overrides?.maxTokens ?? config.parameters.maxTokens,
    });
  }

  /**
   * Call the LLM with streaming — emits tokens via WebSocket in real-time.
   * Returns the full accumulated content when done.
   */
  protected async callLlmStreaming(
    ctx: AgentContext,
    messages: LlmMessage[],
    overrides?: { temperature?: number; maxTokens?: number },
  ): Promise<LlmCompletionResult> {
    const config = this.getRoleConfig();

    // Notify frontend: stream starting
    this.chatGateway.emitToSession(ctx.chatSessionId, 'chatStreamStart', {
      chatSessionId: ctx.chatSessionId,
      role: this.role,
    });

    let fullContent = '';

    try {
      const stream = this.llmService.completeStream({
        provider: config.provider,
        model: config.model,
        messages,
        temperature: overrides?.temperature ?? config.parameters.temperature,
        maxTokens: overrides?.maxTokens ?? config.parameters.maxTokens,
      });

      for await (const chunk of stream) {
        if (chunk.content) {
          fullContent += chunk.content;
          this.chatGateway.emitToSession(ctx.chatSessionId, 'chatStreamToken', {
            chatSessionId: ctx.chatSessionId,
            token: chunk.content,
          });
        }
      }
    } catch (err) {
      this.logger.error(`Streaming failed: ${err.message}`);
    }

    // Notify frontend: stream complete
    this.chatGateway.emitToSession(ctx.chatSessionId, 'chatStreamEnd', {
      chatSessionId: ctx.chatSessionId,
    });

    return {
      content: fullContent,
      finishReason: fullContent ? 'stop' : 'error',
    };
  }

  /** Update agent instance status + broadcast via WebSocket */
  protected async updateStatus(
    ctx: AgentContext,
    status: AgentStatus,
  ) {
    await this.prisma.agentInstance.update({
      where: { id: ctx.agentInstanceId },
      data: { status },
    });

    this.chatGateway.emitToSession(ctx.chatSessionId, 'agentStatus', {
      agentInstanceId: ctx.agentInstanceId,
      role: this.role,
      status,
      projectId: ctx.projectId,
    });
  }

  /** Write to AgentLog table */
  protected async log(
    agentTaskId: string,
    level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR',
    message: string,
    data?: Record<string, unknown>,
  ) {
    await this.prisma.agentLog.create({
      data: {
        agentTaskId,
        level,
        message,
        ...(data && { data: data as any }),
      },
    });
  }

  /** Map Prisma MessageRole to LLM role */
  private mapRole(role: MessageRole): 'system' | 'user' | 'assistant' {
    switch (role) {
      case MessageRole.USER:
        return 'user';
      case MessageRole.SYSTEM:
        return 'system';
      case MessageRole.ASSISTANT:
      case MessageRole.AGENT:
        return 'assistant';
      default:
        return 'user';
    }
  }
}
