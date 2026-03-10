import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as path from 'path';
import * as fs from 'fs';
import { PrismaService } from '../../prisma/prisma.service';
import { SystemSettingsService } from '../../settings/system-settings.service';
import { ChatService } from '../../chat/chat.service';
import { ChatGateway } from '../../chat/chat.gateway';
import { LlmService } from '../../llm/llm.service';
import { GitlabService } from '../../gitlab/gitlab.service';
import { McpAgentLoopService } from '../../mcp/mcp-agent-loop.service';
import { McpRegistryService } from '../../mcp/mcp-registry.service';
import { LlmMessage } from '../../llm/llm.interfaces';
import { BaseAgent, AgentContext } from '../agent-base';
import { MonitorGateway } from '../../monitor/monitor.gateway';
import { postAgentComment } from '../agent-comment.utils';
import {
  AgentRole,
  AgentStatus,
  AgentTaskStatus,
  AgentTaskType,
  IssueStatus,
} from '@prisma/client';

const DESIGN_COMPLETION_MARKER = ':::ARCHITECTURE_DESIGNED:::';
const GROUNDING_COMPLETION_MARKER = ':::GROUNDING_COMPLETE:::';

const DEFAULT_DESIGN_PROMPT = `You are the Architect Agent for a software project.
Your job is to analyze the project's tech stack and codebase, then produce a clear architecture overview.

## If the workspace already has code:
- Analyze the existing folder structure, patterns, and conventions
- Identify key components, services, models, and their relationships
- Note design patterns in use (MVC, service layer, repository pattern, etc.)
- Identify extension points for new features

## If the workspace is empty or minimal:
- Design the architecture based on the tech stack from the interview
- Propose folder structure, component breakdown, and data flow
- Recommend patterns and conventions

## Output Format
Provide a structured architecture overview in markdown. Include:
1. **Project Type & Stack** — What kind of project, which frameworks
2. **Folder Structure** — Key directories and their purpose
3. **Architecture Patterns** — Design patterns, data flow, state management
4. **Key Components** — Main modules/services/components and their roles
5. **Extension Points** — Where new features should be added

End your response with the marker: ${DESIGN_COMPLETION_MARKER}`;

const DEFAULT_GROUNDING_PROMPT = `You are the Architect Agent performing code grounding for a specific issue.
Your job is to analyze the existing codebase and create a precise implementation plan.

## Your Task
For the given issue, you MUST:
1. Read relevant source files using the filesystem tools
2. Identify which files need to be created or modified
3. Find existing patterns and conventions to follow
4. Create a concrete, actionable plan for the Coder Agent

## Output Format
Write a structured analysis as a markdown comment. Include:

### Relevant Files
- List existing files that relate to this issue, with line numbers where applicable

### Files to Create
- New files that need to be created, with suggested location

### Files to Modify
- Existing files that need changes, with specific sections/functions

### Approach
- Step-by-step implementation plan
- Which existing patterns to follow (reference specific files/classes)

### Technical Notes
- Framework-specific considerations
- Potential pitfalls or edge cases

End your response with the marker: ${GROUNDING_COMPLETION_MARKER}`;

@Injectable()
export class ArchitectAgent extends BaseAgent {
  readonly role = AgentRole.ARCHITECT;
  protected readonly logger = new Logger(ArchitectAgent.name);

  constructor(
    prisma: PrismaService,
    settings: SystemSettingsService,
    chatService: ChatService,
    chatGateway: ChatGateway,
    llmService: LlmService,
    private readonly gitlabService: GitlabService,
    monitorGateway: MonitorGateway,
    private readonly mcpAgentLoop: McpAgentLoopService,
    private readonly mcpRegistry: McpRegistryService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    super(prisma, settings, chatService, chatGateway, llmService, monitorGateway);
  }

  // ─── Phase A: Architecture Design ────────────────────────────

  /**
   * Phase A: Analyze the project and design/document the architecture.
   * Runs once after DevOps setup, before Issue Compiler.
   */
  async designArchitecture(ctx: AgentContext): Promise<void> {
    try {
      await this.updateStatus(ctx, AgentStatus.WORKING);
      await this.sendAgentMessage(ctx, '🏗️ **Architect** — Analysiere Projektstruktur und entwerfe Architektur...');
      await this.log(ctx.agentTaskId, 'INFO', 'Phase A: Architecture design started');

      const project = await this.prisma.project.findUnique({
        where: { id: ctx.projectId },
      });
      if (!project) {
        await this.markFailed(ctx, 'Project not found');
        return;
      }

      const workspace = path.resolve(this.settings.devopsWorkspacePath, project.slug);
      const hasCode = this.workspaceHasCode(workspace);

      // Build the user prompt with project context
      const techStack = project.techStack ? JSON.stringify(project.techStack, null, 2) : 'Not specified';
      const userPrompt = [
        `## Project: ${project.name}`,
        `## Tech Stack:\n\`\`\`json\n${techStack}\n\`\`\``,
        '',
        hasCode
          ? 'The workspace already contains code. Analyze the existing codebase and document the architecture.'
          : 'The workspace is empty or minimal. Design the architecture based on the tech stack.',
        '',
        `Workspace path: ${workspace}`,
      ].join('\n');

      let architectureOverview: string;

      if (hasCode) {
        // Use MCP Agent Loop to read files and analyze
        architectureOverview = await this.analyzeWithMcp(ctx, workspace, userPrompt);
      } else {
        // No code yet — use plain LLM call to design architecture
        architectureOverview = await this.designWithLlm(ctx, userPrompt);
      }

      if (!architectureOverview) {
        await this.markFailed(ctx, 'No architecture output from LLM');
        return;
      }

      // Clean up completion marker
      architectureOverview = architectureOverview
        .replace(DESIGN_COMPLETION_MARKER, '')
        .trim();

      // Post architecture overview as chat message
      await this.sendAgentMessage(ctx, `## 🏗️ Architecture Overview\n\n${architectureOverview}`);

      // Complete task
      await this.prisma.agentTask.update({
        where: { id: ctx.agentTaskId },
        data: {
          status: AgentTaskStatus.COMPLETED,
          completedAt: new Date(),
          output: { architectureOverview: architectureOverview.substring(0, 10000) } as any,
        },
      });

      await this.updateStatus(ctx, AgentStatus.IDLE);
      await this.log(ctx.agentTaskId, 'INFO', 'Phase A: Architecture design completed');

      // Trigger Issue Compiler
      this.eventEmitter.emit('agent.architectDesignComplete', {
        projectId: ctx.projectId,
        chatSessionId: ctx.chatSessionId,
      });

    } catch (err) {
      this.logger.error(`Architecture design failed: ${err.message}`, err.stack);
      await this.sendAgentMessage(ctx, `❌ **Architect** Fehler: ${err.message}`);
      await this.markFailed(ctx, err.message);
    }
  }

  // ─── Phase B: Issue Grounding ────────────────────────────────

  /**
   * Phase B: Analyze codebase for each open issue and post grounding comments.
   * Runs after Issue Compiler, before Coder.
   */
  async groundIssues(ctx: AgentContext): Promise<void> {
    try {
      await this.updateStatus(ctx, AgentStatus.WORKING);
      await this.log(ctx.agentTaskId, 'INFO', 'Phase B: Issue grounding started');

      const project = await this.prisma.project.findUnique({
        where: { id: ctx.projectId },
        select: { id: true, slug: true, gitlabProjectId: true, name: true },
      });
      if (!project) {
        await this.markFailed(ctx, 'Project not found');
        return;
      }

      // Find all OPEN issues for this project
      // Only ground top-level issues (not sub-tasks)
      const issues = await this.prisma.issue.findMany({
        where: {
          projectId: ctx.projectId,
          status: IssueStatus.OPEN,
          parentId: null,
        },
        orderBy: { createdAt: 'asc' },
        include: {
          parent: { select: { title: true } },
          subIssues: { select: { title: true } },
        },
      });

      if (issues.length === 0) {
        await this.sendAgentMessage(ctx, '🏗️ **Architect** — Keine offenen Issues gefunden, überspringe Grounding.');
        await this.completeGrounding(ctx, 0);
        return;
      }

      await this.sendAgentMessage(
        ctx,
        `🏗️ **Architect** — Analysiere ${issues.length} Issue(s) und erstelle Grounding-Kommentare...`,
      );

      const workspace = path.resolve(this.settings.devopsWorkspacePath, project.slug);
      let groundedCount = 0;

      for (const issue of issues) {
        try {
          await this.log(ctx.agentTaskId, 'INFO', `Grounding issue: ${issue.title} (#${issue.gitlabIid ?? issue.id})`);

          const groundingComment = await this.groundSingleIssue(ctx, workspace, project, issue);

          if (groundingComment && project.gitlabProjectId && issue.gitlabIid) {
            await postAgentComment({
              prisma: this.prisma,
              gitlabService: this.gitlabService,
              issueId: issue.id,
              gitlabProjectId: project.gitlabProjectId,
              issueIid: issue.gitlabIid,
              agentTaskId: ctx.agentTaskId,
              authorName: 'Architect',
              markdownContent: groundingComment,
            });
            groundedCount++;
          }
        } catch (err) {
          this.logger.warn(`Grounding failed for issue ${issue.id}: ${err.message}`);
          await this.log(ctx.agentTaskId, 'WARN', `Grounding failed for issue ${issue.title}: ${err.message}`);
          // Continue with next issue — don't fail the whole batch
        }
      }

      await this.sendAgentMessage(
        ctx,
        `✅ **Architect** — Grounding abgeschlossen: ${groundedCount}/${issues.length} Issues analysiert.`,
      );

      await this.completeGrounding(ctx, groundedCount);

    } catch (err) {
      this.logger.error(`Issue grounding failed: ${err.message}`, err.stack);
      await this.sendAgentMessage(ctx, `❌ **Architect** Grounding-Fehler: ${err.message}`);
      await this.markFailed(ctx, err.message);
    }
  }

  // ─── Private: MCP-based analysis ─────────────────────────────

  /**
   * Use MCP Agent Loop with filesystem tools to analyze existing code.
   */
  private async analyzeWithMcp(
    ctx: AgentContext,
    workspace: string,
    userPrompt: string,
  ): Promise<string> {
    const config = this.getRoleConfig();
    const systemPrompt = config.systemPrompt || DEFAULT_DESIGN_PROMPT;

    // Skip MCP entirely if model doesn't support tools (e.g. deepseek-r1)
    if (!this.modelSupportsTools()) {
      this.logger.log('Model does not support tools — skipping MCP, using direct LLM');
      return this.designWithLlm(ctx, userPrompt);
    }

    const mcpServers = await this.mcpRegistry.resolveServersForRole(
      AgentRole.ARCHITECT,
      { workspace, allowedPaths: [workspace], projectId: ctx.projectId },
    );

    if (mcpServers.length === 0) {
      this.logger.warn('No MCP servers configured for Architect — falling back to plain LLM');
      return this.designWithLlm(ctx, userPrompt);
    }

    const result = await this.mcpAgentLoop.run({
      provider: config.provider,
      model: config.model,
      systemPrompt,
      userPrompt,
      mcpServers,
      maxIterations: 30,
      temperature: config.parameters.temperature,
      maxTokens: config.parameters.maxTokens,
      onToolCall: (name, args) => {
        this.log(ctx.agentTaskId, 'DEBUG', `MCP tool: ${name}`, { args: JSON.stringify(args).substring(0, 300) } as any);
      },
    });

    this.logger.log(
      `Phase A MCP loop: ${result.iterations} iterations, ${result.toolCallsExecuted} tool calls, ${result.durationMs}ms`,
    );

    if (result.finishReason === 'error' && result.toolCallsExecuted === 0) {
      return this.designWithLlm(ctx, userPrompt);
    }

    return result.content;
  }

  /**
   * Plain LLM call for architecture design (no MCP needed for empty repos).
   */
  private async designWithLlm(ctx: AgentContext, userPrompt: string): Promise<string> {
    const config = this.getRoleConfig();
    const systemPrompt = config.systemPrompt || DEFAULT_DESIGN_PROMPT;

    const messages: LlmMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];

    const result = await this.callLlm(messages);

    if (result.finishReason === 'error') {
      this.logger.error('Phase A LLM call failed');
      return '';
    }

    return result.content;
  }

  /**
   * Ground a single issue: read relevant code via MCP, produce analysis comment.
   */
  private async groundSingleIssue(
    ctx: AgentContext,
    workspace: string,
    project: { id: string; slug: string; gitlabProjectId: number | null; name: string },
    issue: { id: string; title: string; description: string | null; gitlabIid: number | null; parent?: { title: string } | null; subIssues?: { title: string }[] },
  ): Promise<string> {
    const config = this.getRoleConfig();
    const systemPrompt = config.systemPrompt || DEFAULT_GROUNDING_PROMPT;

    // Build issue context
    const issueContext = [
      `## Issue: ${issue.title}`,
      issue.gitlabIid ? `GitLab: #${issue.gitlabIid}` : '',
      issue.parent ? `Parent Issue: ${issue.parent.title}` : '',
      issue.subIssues?.length ? `Sub-Tasks: ${issue.subIssues.map(c => c.title).join(', ')}` : '',
      '',
      '## Description:',
      issue.description || '(No description)',
      '',
      `## Project: ${project.name}`,
      `## Workspace: ${workspace}`,
      '',
      'Analyze the codebase and create a precise implementation plan for this issue.',
      'Use the filesystem tools to read relevant files.',
    ].filter(Boolean).join('\n');

    // Check if workspace has code AND model supports tools — use MCP if both, plain LLM otherwise
    if (this.workspaceHasCode(workspace) && this.modelSupportsTools()) {
      const mcpServers = await this.mcpRegistry.resolveServersForRole(
        AgentRole.ARCHITECT,
        { workspace, allowedPaths: [workspace], projectId: ctx.projectId },
      );

      if (mcpServers.length > 0) {
        const result = await this.mcpAgentLoop.run({
          provider: config.provider,
          model: config.model,
          systemPrompt,
          userPrompt: issueContext,
          mcpServers,
          maxIterations: 30,
          temperature: config.parameters.temperature,
          maxTokens: config.parameters.maxTokens,
          onToolCall: (name, args) => {
            this.log(ctx.agentTaskId, 'DEBUG', `Grounding MCP: ${name}`, { issue: issue.title } as any);
          },
        });

        if (result.content) {
          return this.formatGroundingComment(result.content, issue.title);
        }
      }
    }

    // Fallback: Plain LLM call without filesystem access
    const messages: LlmMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: issueContext },
    ];

    const result = await this.callLlm(messages);
    if (result.finishReason === 'error' || !result.content) return '';

    return this.formatGroundingComment(result.content, issue.title);
  }

  // ─── Private: Helpers ────────────────────────────────────────

  /**
   * Check if the configured model supports tool/function calling.
   * Models like deepseek-r1 do NOT support tools — MCP loops are useless for them.
   */
  private modelSupportsTools(): boolean {
    const config = this.getRoleConfig();
    const model = (config.model || '').toLowerCase();
    // Known non-tool models
    const noToolModels = ['deepseek-r1', 'deepseek-r2', 'llama2', 'granite-code', 'qwen2.5-coder', 'llava'];
    return !noToolModels.some((m) => model.includes(m));
  }

  /**
   * Check if the workspace directory has meaningful code (not just config files).
   */
  private workspaceHasCode(workspace: string): boolean {
    try {
      if (!fs.existsSync(workspace)) return false;

      const entries = fs.readdirSync(workspace);
      // A workspace with just .git or nothing is "empty"
      const meaningfulFiles = entries.filter(
        (e) => !e.startsWith('.') && e !== 'node_modules' && e !== '.git',
      );
      return meaningfulFiles.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Format the LLM output as a clean grounding comment.
   */
  private formatGroundingComment(content: string, issueTitle: string): string {
    // Strip completion markers
    const cleaned = content
      .replace(GROUNDING_COMPLETION_MARKER, '')
      .replace(DESIGN_COMPLETION_MARKER, '')
      .trim();

    return [
      `## 🏗️ Architect Analysis — "${issueTitle}"`,
      '',
      cleaned,
      '',
      '---',
      '_Analysis by Architect Agent_',
    ].join('\n');
  }

  /**
   * Complete the grounding phase and trigger Coder.
   */
  private async completeGrounding(ctx: AgentContext, groundedCount: number): Promise<void> {
    await this.prisma.agentTask.update({
      where: { id: ctx.agentTaskId },
      data: {
        status: AgentTaskStatus.COMPLETED,
        completedAt: new Date(),
        output: { groundedIssues: groundedCount } as any,
      },
    });

    await this.updateStatus(ctx, AgentStatus.IDLE);
    await this.log(ctx.agentTaskId, 'INFO', `Phase B completed: ${groundedCount} issues grounded`);

    // Trigger Coder
    this.eventEmitter.emit('agent.architectGroundingComplete', {
      projectId: ctx.projectId,
      chatSessionId: ctx.chatSessionId,
    });
  }

  /**
   * Mark task as failed.
   */
  private async markFailed(ctx: AgentContext, reason: string): Promise<void> {
    try {
      await this.prisma.agentTask.update({
        where: { id: ctx.agentTaskId },
        data: {
          status: AgentTaskStatus.FAILED,
          completedAt: new Date(),
        },
      });
      await this.updateStatus(ctx, AgentStatus.ERROR);
      await this.log(ctx.agentTaskId, 'ERROR', `Failed: ${reason}`);
    } catch (err) {
      this.logger.error(`Failed to mark task as failed: ${err.message}`);
    }
  }
}
