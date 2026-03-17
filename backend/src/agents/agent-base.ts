import { Logger } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../settings/system-settings.service';
import { ChatService } from '../chat/chat.service';
import { ChatGateway } from '../chat/chat.gateway';
import { LlmService } from '../llm/llm.service';
import { LlmMessage, LlmCompletionResult } from '../llm/llm.interfaces';
import { MonitorGateway } from '../monitor/monitor.gateway';
import {
  AgentRole,
  AgentStatus,
  ChatSessionType,
  MessageRole,
} from '@prisma/client';

export const KNOWLEDGE_BASE_FILE = 'PROJECT_KNOWLEDGE.md';
export const ENVIRONMENT_FILE = 'ENVIRONMENT.md';

/**
 * Sanitize an object for safe storage as Prisma JSON/JSONB.
 * Removes control characters and NUL bytes that PostgreSQL JSONB rejects.
 * Use this before `output: result as any` in agentTask.update().
 */
export function sanitizeJsonOutput(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') {
    // Remove NUL bytes and control chars (except \n, \r, \t)
    return obj.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  }
  if (Array.isArray(obj)) {
    return obj.map(sanitizeJsonOutput);
  }
  if (typeof obj === 'object') {
    const clean: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      clean[key] = sanitizeJsonOutput(value);
    }
    return clean;
  }
  return obj; // numbers, booleans
}

/** Minimal interface for wiki reads — avoids coupling BaseAgent to GitlabService */
export interface WikiReader {
  getWikiPageContent(projectId: number, slug: string): Promise<string | null>;
}

/**
 * Compute the worktree path for a dev session.
 * Convention: {devopsWorkspacePath}/.session-worktrees/{projectSlug}--{sanitizedBranch}/
 */
export function getSessionWorktreePath(
  devopsWorkspacePath: string,
  projectSlug: string,
  branch: string,
): string {
  const sanitized = branch.replace(/[^a-zA-Z0-9_-]/g, '-');
  return path.resolve(
    devopsWorkspacePath,
    '.session-worktrees',
    `${projectSlug}--${sanitized}`,
  );
}

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
    protected readonly monitorGateway?: MonitorGateway,
  ) {}

  /** Get the agent role config from SystemSettings */
  protected getRoleConfig() {
    return this.settings.getAgentRoleConfig(this.role);
  }

  /** Send a message as AGENT and broadcast via WebSocket */
  protected async sendAgentMessage(ctx: AgentContext, content: string) {
    const message = await this.chatService.addMessage({
      chatSessionId: ctx.chatSessionId,
      role: MessageRole.AGENT,
      content,
      agentTaskId: ctx.agentTaskId,
    });

    this.chatGateway.emitToSession(ctx.chatSessionId, 'newMessage', message);

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

  /** Get git timeout from pipeline config (seconds → ms) */
  protected getGitTimeoutMs(): number {
    const cfg = this.settings.getPipelineConfig();
    return (cfg.gitTimeoutSeconds ?? 60) * 1000;
  }

  /** Get max review diffs from pipeline config */
  protected getMaxReviewDiffs(): number {
    const cfg = this.settings.getPipelineConfig();
    return cfg.maxReviewDiffs ?? 25;
  }

  /** Call the LLM with the configured provider/model for this role */
  protected async callLlm(
    messages: LlmMessage[],
    overrides?: {
      temperature?: number;
      maxTokens?: number;
      timeoutMs?: number;
      enableReasoning?: boolean;
    },
  ) {
    const config = this.getRoleConfig();

    return this.llmService.complete({
      provider: config.provider,
      model: config.model,
      messages,
      temperature: overrides?.temperature ?? config.parameters.temperature,
      maxTokens: overrides?.maxTokens ?? config.parameters.maxTokens,
      timeoutMs: overrides?.timeoutMs ?? this.getCliTimeoutMs(),
      enableReasoning: overrides?.enableReasoning ?? config.enableReasoning,
    });
  }

  /** Get CLI tool timeout from pipeline config (minutes → ms), default 90 min */
  private getCliTimeoutMs(): number {
    const cfg = this.settings.getPipelineConfig();
    const minutes = cfg.cliTimeoutMinutes ?? 90;
    return minutes * 60 * 1000;
  }

  /**
   * Call the LLM with streaming — emits tokens via WebSocket in real-time.
   * Returns the full accumulated content when done.
   */
  protected async callLlmStreaming(
    ctx: AgentContext,
    messages: LlmMessage[],
    overrides?: {
      temperature?: number;
      maxTokens?: number;
      enableReasoning?: boolean;
    },
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
        enableReasoning: overrides?.enableReasoning ?? config.enableReasoning,
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
  protected async updateStatus(ctx: AgentContext, status: AgentStatus) {
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

  /** Write to AgentLog table + emit via WebSocket for Live Feed */
  protected async log(
    agentTaskId: string,
    level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR',
    message: string,
    data?: Record<string, unknown>,
    projectId?: string,
  ) {
    const logEntry = await this.prisma.agentLog.create({
      data: {
        agentTaskId,
        level,
        message,
        ...(data && { data: data as any }),
      },
    });

    // Emit to Live Feed via MonitorGateway
    if (this.monitorGateway && level !== 'DEBUG') {
      const pid = projectId ?? (await this.resolveProjectId(agentTaskId));
      if (pid) {
        this.monitorGateway.emitLogEntry(pid, {
          id: logEntry.id,
          level,
          message,
          data,
          agentRole: this.role,
          agentTaskId,
          projectId: pid,
          createdAt: logEntry.createdAt,
        });
      }
    }
  }

  /** Resolve projectId from agentTaskId (cached per task) */
  private projectIdCache = new Map<string, string>();
  private async resolveProjectId(agentTaskId: string): Promise<string | null> {
    const cached = this.projectIdCache.get(agentTaskId);
    if (cached) return cached;
    try {
      const task = await this.prisma.agentTask.findUnique({
        where: { id: agentTaskId },
        select: { agent: { select: { projectId: true } } },
      });
      const pid = task?.agent?.projectId ?? null;
      if (pid) this.projectIdCache.set(agentTaskId, pid);
      return pid;
    } catch {
      return null;
    }
  }

  /**
   * Read the project knowledge base from workspace.
   * Returns the content or empty string if not found.
   * Optionally truncate to maxChars to avoid blowing up prompts.
   */
  protected async readProjectKnowledge(
    workspace: string,
    maxChars = 6000,
  ): Promise<string> {
    try {
      const filePath = path.resolve(workspace, KNOWLEDGE_BASE_FILE);
      const content = await fs.readFile(filePath, 'utf-8');
      if (content.length > maxChars) {
        return content.substring(0, maxChars) + '\n\n... (truncated)';
      }
      return content;
    } catch {
      return '';
    }
  }

  /**
   * Build a prompt section from the knowledge base content.
   * Returns empty string if no knowledge base found.
   */
  protected async buildKnowledgeSection(workspace: string): Promise<string> {
    const kb = await this.readProjectKnowledge(workspace);
    if (!kb) return '';
    return `\n## Project Knowledge Base\n${kb}\n`;
  }

  /**
   * Read the ENVIRONMENT.md from workspace.
   * Returns the content or empty string if not found.
   */
  protected async readEnvironmentDoc(
    workspace: string,
    maxChars = 8000,
  ): Promise<string> {
    try {
      const filePath = path.resolve(workspace, ENVIRONMENT_FILE);
      const content = await fs.readFile(filePath, 'utf-8');
      if (content.length > maxChars) {
        return content.substring(0, maxChars) + '\n\n... (truncated)';
      }
      return content;
    } catch {
      return '';
    }
  }

  // ─── Wiki-First Reading Methods ─────────────────────────────
  // These try the GitLab Wiki first, then fall back to local files.
  // Agents pass their injected gitlabService + the project's gitlabProjectId.

  /**
   * Read project knowledge — Wiki-First with file fallback.
   * Pass wikiReader=null to skip wiki and read from file only.
   */
  protected async readKnowledge(
    wikiReader: WikiReader | null,
    gitlabProjectId: number | null | undefined,
    workspace: string,
    maxChars = 6000,
  ): Promise<string> {
    if (wikiReader && gitlabProjectId) {
      try {
        const content = await wikiReader.getWikiPageContent(
          gitlabProjectId,
          'PROJECT_KNOWLEDGE',
        );
        if (content) {
          this.logger.debug('Knowledge read from wiki');
          return content.length > maxChars
            ? content.substring(0, maxChars) + '\n\n... (truncated)'
            : content;
        }
      } catch {
        // Wiki unavailable — fall through to file
      }
    }
    return this.readProjectKnowledge(workspace, maxChars);
  }

  /**
   * Read environment doc — Wiki-First with file fallback.
   * Pass wikiReader=null to skip wiki and read from file only.
   */
  protected async readEnvironment(
    wikiReader: WikiReader | null,
    gitlabProjectId: number | null | undefined,
    workspace: string,
    maxChars = 8000,
  ): Promise<string> {
    if (wikiReader && gitlabProjectId) {
      try {
        const content = await wikiReader.getWikiPageContent(
          gitlabProjectId,
          'ENVIRONMENT',
        );
        if (content) {
          this.logger.debug('Environment doc read from wiki');
          return content.length > maxChars
            ? content.substring(0, maxChars) + '\n\n... (truncated)'
            : content;
        }
      } catch {
        // Wiki unavailable — fall through to file
      }
    }
    return this.readEnvironmentDoc(workspace, maxChars);
  }

  /**
   * Build a prompt section from knowledge base — Wiki-First with file fallback.
   */
  protected async buildKnowledgeSectionWiki(
    wikiReader: WikiReader | null,
    gitlabProjectId: number | null | undefined,
    workspace: string,
  ): Promise<string> {
    const kb = await this.readKnowledge(wikiReader, gitlabProjectId, workspace);
    if (!kb) return '';
    return `\n## Project Knowledge Base\n${kb}\n`;
  }

  /**
   * Resolve the correct workspace path for an agent context.
   * Dev sessions use git worktrees, infrastructure uses the main workspace.
   */
  protected async resolveWorkspace(
    projectSlug: string,
    chatSessionId?: string,
  ): Promise<string> {
    let workspace: string;

    if (chatSessionId) {
      const session = await this.prisma.chatSession.findUnique({
        where: { id: chatSessionId },
        select: { type: true, branch: true },
      });

      if (session?.type === ChatSessionType.DEV_SESSION && session.branch) {
        workspace = getSessionWorktreePath(
          this.settings.devopsWorkspacePath,
          projectSlug,
          session.branch,
        );
      } else {
        workspace = path.resolve(
          this.settings.devopsWorkspacePath,
          projectSlug,
        );
      }
    } else {
      workspace = path.resolve(this.settings.devopsWorkspacePath, projectSlug);
    }

    // Workspace fence: ensure package.json exists so npm never escapes upward
    await this.ensureWorkspaceFence(workspace);

    return workspace;
  }

  /**
   * Workspace fence: ensures a package.json exists in the workspace root.
   * Without this, npm/npx walk up the directory tree and can modify
   * the Hub's own package.json — catastrophic for the Coder agent.
   */
  protected async ensureWorkspaceFence(workspace: string): Promise<void> {
    const pkgPath = path.join(workspace, 'package.json');
    try {
      await fs.access(pkgPath);
    } catch {
      // Only create if workspace dir exists (it might not exist yet during setup)
      try {
        await fs.access(workspace);
        await fs.writeFile(
          pkgPath,
          JSON.stringify(
            {
              name: path.basename(workspace),
              version: '0.0.0',
              private: true,
            },
            null,
            2,
          ) + '\n',
        );
        this.logger.debug(
          `Workspace fence: created sentinel package.json in ${workspace}`,
        );
      } catch {
        // Workspace doesn't exist yet — skip
      }
    }
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
