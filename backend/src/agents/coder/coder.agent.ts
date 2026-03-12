import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import { PrismaService } from '../../prisma/prisma.service';
import { SystemSettingsService } from '../../settings/system-settings.service';
import { ChatService } from '../../chat/chat.service';
import { ChatGateway } from '../../chat/chat.gateway';
import { LlmService } from '../../llm/llm.service';
import { GitlabService } from '../../gitlab/gitlab.service';
import { IssuesService } from '../../issues/issues.service';
import { McpAgentLoopService } from '../../mcp/mcp-agent-loop.service';
import { McpRegistryService } from '../../mcp/mcp-registry.service';
import { BaseAgent, AgentContext } from '../agent-base';
import { MonitorGateway } from '../../monitor/monitor.gateway';
import { postAgentComment } from '../agent-comment.utils';
import { CoderIssueResult } from './coder-result.interface';
import {
  AgentRole,
  AgentStatus,
  AgentTaskStatus,
  AgentTaskType,
  ChatSessionType,
  IssueStatus,
} from '@prisma/client';

const execFileAsync = promisify(execFile);

/** Timeout for MCP agent loop (10 minutes) */
// No timeout — LLMs get unlimited time (only maxIterations limits the loop)
/** Timeout for git operations */
const GIT_TIMEOUT_MS = 60_000;

@Injectable()
export class CoderAgent extends BaseAgent {
  readonly role = AgentRole.CODER;
  protected readonly logger = new Logger(CoderAgent.name);

  constructor(
    prisma: PrismaService,
    settings: SystemSettingsService,
    chatService: ChatService,
    chatGateway: ChatGateway,
    llmService: LlmService,
    private readonly gitlabService: GitlabService,
    private readonly issuesService: IssuesService,
    monitorGateway: MonitorGateway,
    private readonly eventEmitter: EventEmitter2,
    private readonly mcpAgentLoop: McpAgentLoopService,
    private readonly mcpRegistry: McpRegistryService,
  ) {
    super(prisma, settings, chatService, chatGateway, llmService, monitorGateway);
  }

  // ─── Main Entry: Milestone Coding ──────────────────────────

  /**
   * Code all issues in the first open milestone sequentially.
   * Called when issueCompilerComplete fires.
   */
  async runMilestoneCoding(ctx: AgentContext): Promise<void> {
    try {
      await this.updateStatus(ctx, AgentStatus.WORKING);

      // Load project
      const project = await this.prisma.project.findUnique({
        where: { id: ctx.projectId },
      });
      if (!project?.gitlabProjectId) {
        await this.sendAgentMessage(ctx, '❌ Project has no GitLab repo linked');
        await this.markFailed(ctx, 'No GitLab repo linked');
        return;
      }

      // Determine if running in a dev session
      let isDevSession = false;
      let chatSessionFilter: { chatSessionId?: string } = {};
      if (ctx.chatSessionId) {
        const session = await this.prisma.chatSession.findUnique({
          where: { id: ctx.chatSessionId },
          select: { type: true },
        });
        isDevSession = session?.type === ChatSessionType.DEV_SESSION;
        if (isDevSession) {
          chatSessionFilter = { chatSessionId: ctx.chatSessionId };
        }
      }

      // Resolve workspace — dev sessions use git worktrees
      const workspace = await this.resolveWorkspace(project.slug, ctx.chatSessionId);

      // Pull latest on workspace
      await this.gitPull(workspace);

      // Find the NEXT open issue — scoped to session if dev session
      // Sequential strategy: we only process ONE issue at a time.
      // After the full pipeline (Review → Test → Docs → Merge), the orchestrator triggers us again.
      const milestones = await this.prisma.milestone.findMany({
        where: {
          projectId: ctx.projectId,
          issues: {
            some: {
              status: IssueStatus.OPEN,
              parentId: null,
              ...chatSessionFilter,
            },
          },
        },
        include: {
          issues: {
            where: { parentId: null, status: IssueStatus.OPEN, ...chatSessionFilter },
            include: {
              subIssues: { orderBy: { sortOrder: 'asc' } },
            },
            orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
            take: 1, // Only the first open issue per milestone
          },
        },
        orderBy: { sortOrder: 'asc' },
        take: 1, // Only the first milestone with open issues
      });

      if (milestones.length === 0 || milestones[0].issues.length === 0) {
        await this.sendAgentMessage(ctx, '📭 No open issues found — all done!');
        await this.updateStatus(ctx, AgentStatus.IDLE);
        return;
      }

      const milestone = milestones[0];
      const issue = milestone.issues[0];

      // Count remaining open issues for context
      const remainingCount = await this.prisma.issue.count({
        where: { projectId: ctx.projectId, status: IssueStatus.OPEN, parentId: null, ...chatSessionFilter },
      });

      await this.sendAgentMessage(
        ctx,
        `💻 **Coder Agent** — processing issue #${issue.gitlabIid ?? '?'}: **${issue.title}** (${remainingCount} remaining)`,
      );

      // Get the base branch: prefer project.workBranch (e.g. "develop"), fallback to GitLab default
      const glProject = await this.gitlabService.getProject(project.gitlabProjectId);
      const defaultBranch = project.workBranch || glProject.default_branch;

      // Check if this session has its own branch (session-based branching)
      // With worktrees, the session workspace is already on the correct branch
      const chatSession = ctx.chatSessionId
        ? await this.prisma.chatSession.findUnique({
            where: { id: ctx.chatSessionId },
            select: { branch: true, type: true },
          })
        : null;
      const sessionBranch = chatSession?.type === 'DEV_SESSION' ? chatSession.branch : null;

      const issueResult = await this.processIssue(ctx, issue, workspace, project.gitlabProjectId, defaultBranch, glProject.path_with_namespace, sessionBranch);

      const statusEmoji = issueResult.status === 'success' ? '✅' : issueResult.status === 'failed' ? '❌' : '⏭️';
      await this.sendAgentMessage(
        ctx,
        `${statusEmoji} Issue #${issue.gitlabIid ?? '?'} ${issueResult.status}${issueResult.mrIid ? ` — MR !${issueResult.mrIid}` : ''} (${remainingCount - 1} issues remaining)`,
      );

      // If coding failed (no codingComplete event), emit codingFailed so
      // the orchestrator can skip to the next issue in the sequential pipeline
      if (issueResult.status === 'failed') {
        this.eventEmitter.emit('agent.codingFailed', {
          projectId: ctx.projectId,
          chatSessionId: ctx.chatSessionId,
          issueId: issue.id,
        });
      }

      await this.updateStatus(ctx, AgentStatus.IDLE);

    } catch (err) {
      this.logger.error(`Milestone coding crashed: ${err.message}`, err.stack);
      await this.sendAgentMessage(ctx, `❌ **Coder Agent** error: ${err.message}`);
      await this.markFailed(ctx, err.message);
    }
  }

  // ─── Process Single Issue ──────────────────────────────────

  private async processIssue(
    ctx: AgentContext,
    issue: any,
    workspace: string,
    gitlabProjectId: number,
    defaultBranch: string,
    projectPath: string,
    sessionBranch?: string | null,
  ): Promise<CoderIssueResult> {
    const start = Date.now();
    // Always create a feature branch — for session issues it branches from the session branch
    const branchName = `feature/${issue.gitlabIid ?? issue.id}-${this.slugify(issue.title)}`;
    const baseBranch = sessionBranch || defaultBranch;
    const result: CoderIssueResult = {
      issueId: issue.id,
      gitlabIid: issue.gitlabIid,
      branch: branchName,
      filesChanged: [],
      status: 'failed',
      durationMs: 0,
    };

    // Reuse the orchestrator-created task instead of creating a duplicate
    const agentTask = { id: ctx.agentTaskId };

    try {
      // Update issue status
      await this.issuesService.update(issue.id, { status: IssueStatus.IN_PROGRESS });

      // Link orchestrator task to this issue
      await this.prisma.agentTask.update({
        where: { id: ctx.agentTaskId },
        data: { issueId: issue.id },
      });

      await this.sendAgentMessage(
        ctx,
        `🔨 Coding issue #${issue.gitlabIid ?? '?'}: **${issue.title}**`,
      );

      // Post start comment
      if (issue.gitlabIid && gitlabProjectId) {
        await postAgentComment({
          prisma: this.prisma,
          gitlabService: this.gitlabService,
          issueId: issue.id,
          gitlabProjectId,
          issueIid: issue.gitlabIid,
          agentTaskId: agentTask.id,
          authorName: 'Coder Agent',
          markdownContent: `## 🤖 Coder Agent Starting\n\nBranch: \`${branchName}\``,
        });
      }

      // Checkout base branch, pull latest, create feature branch
      await this.gitCheckout(workspace, baseBranch);
      await this.gitPull(workspace);
      await this.gitCreateBranch(workspace, branchName);

      // Build the coding prompt
      const prompt = this.buildCodingPrompt(issue);

      // Run MCP agent loop (LLM + filesystem tools)
      await this.log(agentTask.id, 'INFO', `Running MCP agent loop for issue: ${issue.title}`);
      await this.runMcpAgentLoop(workspace, prompt, agentTask.id, ctx.projectId);

      // Check what changed (includes both uncommitted AND committed changes vs base)
      const changedFiles = await this.getChangedFiles(workspace, baseBranch);
      result.filesChanged = changedFiles;

      if (changedFiles.length === 0) {
        await this.sendAgentMessage(ctx, `⚠️ Agent produced no file changes for #${issue.gitlabIid ?? '?'} — marking for manual review`);
        result.status = 'skipped';
        await this.gitCheckout(workspace, baseBranch);

        // Reset issue status so it doesn't stay orphaned in IN_PROGRESS
        await this.issuesService.update(issue.id, { status: IssueStatus.NEEDS_REVIEW });

        await this.prisma.agentTask.update({
          where: { id: agentTask.id },
          data: { status: AgentTaskStatus.COMPLETED, completedAt: new Date() },
        });

        // Emit event so orchestrator can advance (no MR → review will be skipped)
        this.eventEmitter.emit('agent.codingComplete', {
          projectId: ctx.projectId,
          chatSessionId: ctx.chatSessionId,
          issueId: issue.id,
          gitlabIid: issue.gitlabIid,
          mrIid: undefined,
          gitlabProjectId,
          branch: branchName,
        });

        result.durationMs = Date.now() - start;
        return result;
      }

      // Commit & push
      const commitSha = await this.gitCommitAndPush(
        workspace,
        branchName,
        `feat: implement ${issue.title}\n\nCloses #${issue.gitlabIid ?? ''}`,
      );

      // Create MR — always create, targeting session branch for sessions or default for infra
      if (gitlabProjectId) {
        try {
          const mr = await this.gitlabService.createMergeRequest(gitlabProjectId, {
            source_branch: branchName,
            target_branch: baseBranch,
            title: `feat: ${issue.title}`,
            description: `Closes #${issue.gitlabIid ?? ''}\n\n---\n_Automatically created by Coder Agent_\n\n**Changed files:** ${changedFiles.length}\n${changedFiles.map(f => `- \`${f}\``).join('\n')}`,
          });
          result.mrIid = mr.iid;
          result.mrUrl = mr.web_url;

          // Update agent task with MR info
          await this.prisma.agentTask.update({
            where: { id: agentTask.id },
            data: { gitlabMrIid: mr.iid },
          });
        } catch (mrErr) {
          // Handle 409 Conflict — MR already exists for this branch
          if (mrErr?.response?.status === 409 || mrErr?.message?.includes('409')) {
            this.logger.log(`MR already exists for ${branchName}, looking up existing MR`);
            const existingMr = await this.gitlabService.findMergeRequestByBranch(gitlabProjectId, branchName);
            if (existingMr) {
              result.mrIid = existingMr.iid;
              result.mrUrl = existingMr.web_url;
              await this.prisma.agentTask.update({
                where: { id: agentTask.id },
                data: { gitlabMrIid: existingMr.iid },
              });
              this.logger.log(`Found existing MR !${existingMr.iid} for ${branchName}`);
            } else {
              this.logger.warn(`MR creation failed with 409 but no existing MR found for ${branchName}`);
              await this.log(agentTask.id, 'WARN', `MR creation failed: ${mrErr.message}`);
            }
          } else {
            this.logger.warn(`MR creation failed: ${mrErr.message}`);
            await this.log(agentTask.id, 'WARN', `MR creation failed: ${mrErr.message}`);
          }
        }
      }

      // Update issue status → IN_REVIEW
      await this.issuesService.update(issue.id, { status: IssueStatus.IN_REVIEW });

      // Build commit URL for GitLab
      const gitlabBaseUrl = this.settings.gitlabUrl;
      const commitUrl = `${gitlabBaseUrl}/${projectPath}/-/commit/${commitSha}`;
      const commitShort = commitSha.substring(0, 8);
      result.commitSha = commitSha;
      result.commitUrl = commitUrl;

      // Post implementation-complete comment (same rich markdown for local + GitLab)
      if (issue.gitlabIid && gitlabProjectId) {
        const commentBody = [
          `## 🔨 Implementation Complete`,
          '',
          `**Commit:** [\`${commitShort}\`](${commitUrl}) — [View Diff](${commitUrl})`,
          `**Branch:** \`${branchName}\``,
          result.mrUrl ? `**MR:** [!${result.mrIid}](${result.mrUrl})` : '',
          `**Changed files (${changedFiles.length}):**`,
          ...changedFiles.map(f => `- \`${f}\``),
          '',
          '---',
          '_Implemented by Coder Agent_',
        ].filter(Boolean).join('\n');

        await postAgentComment({
          prisma: this.prisma,
          gitlabService: this.gitlabService,
          issueId: issue.id,
          gitlabProjectId,
          issueIid: issue.gitlabIid,
          agentTaskId: agentTask.id,
          authorName: 'Coder Agent',
          markdownContent: commentBody,
        });
      }

      // Complete the task
      await this.prisma.agentTask.update({
        where: { id: agentTask.id },
        data: {
          status: AgentTaskStatus.COMPLETED,
          output: result as any,
          completedAt: new Date(),
        },
      });

      result.status = 'success';
      result.durationMs = Date.now() - start;

      // Emit coding complete — always emit so the pipeline advances
      this.eventEmitter.emit('agent.codingComplete', {
        projectId: ctx.projectId,
        chatSessionId: ctx.chatSessionId,
        issueId: issue.id,
        gitlabIid: issue.gitlabIid,
        mrIid: result.mrIid,
        gitlabProjectId,
        branch: branchName,
      });
      if (!result.mrIid) {
        this.logger.warn(`No MR created for issue ${issue.gitlabIid} — codingComplete emitted without MR`);
      }

      // Switch back to base branch (session branch for sessions, default for infra)
      await this.gitCheckout(workspace, baseBranch);

      return result;

    } catch (err) {
      this.logger.error(`processIssue failed for ${issue.title}: ${err.message}`);
      result.error = err.message;
      result.status = 'failed';
      result.durationMs = Date.now() - start;

      // Mark task as FAILED in DB (prevents orphaned RUNNING tasks)
      try {
        await this.prisma.agentTask.update({
          where: { id: agentTask.id },
          data: { status: AgentTaskStatus.FAILED, completedAt: new Date(), output: result as any },
        });
      } catch { /* best effort */ }

      await this.sendAgentMessage(
        ctx,
        `❌ Failed to code issue #${issue.gitlabIid ?? '?'}: ${err.message}`,
      );

      // Reset issue status so it can be retried
      try {
        await this.issuesService.update(issue.id, { status: IssueStatus.OPEN });
      } catch { /* best effort */ }

      // Try to switch back to base branch
      try {
        await this.gitCheckout(workspace, baseBranch);
      } catch {
        // Best effort
      }

      return result;
    }
  }

  // ─── Fix Issue (re-trigger from review/pipeline/user) ──────

  /**
   * Fix an existing issue based on feedback.
   * Re-uses existing branch, pushes to the same MR.
   */
  async fixIssue(
    ctx: AgentContext,
    issueId: string,
    feedback: string,
    feedbackSource: 'review' | 'pipeline' | 'user',
  ): Promise<void> {
    // Reuse the orchestrator-created task instead of creating a duplicate
    const agentTask = { id: ctx.agentTaskId };

    try {
      await this.updateStatus(ctx, AgentStatus.WORKING);

      const issue = await this.prisma.issue.findUnique({
        where: { id: issueId },
        include: {
          project: { select: { id: true, slug: true, gitlabProjectId: true, workBranch: true } },
          subIssues: { orderBy: { sortOrder: 'asc' } },
        },
      });

      if (!issue || !issue.project.gitlabProjectId) {
        this.logger.warn(`fixIssue: issue ${issueId} not found or no GitLab project`);
        await this.updateStatus(ctx, AgentStatus.IDLE);
        return;
      }

      // Check if issue belongs to a dev session — use worktree if so
      const issueSession = issue.chatSessionId
        ? await this.prisma.chatSession.findUnique({
            where: { id: issue.chatSessionId },
            select: { type: true, branch: true },
          })
        : null;
      const isSessionIssue = issueSession?.type === ChatSessionType.DEV_SESSION;

      const workspace = isSessionIssue && issueSession?.branch
        ? await this.resolveWorkspace(issue.project.slug, issue.chatSessionId!)
        : path.resolve(this.settings.devopsWorkspacePath, issue.project.slug);
      const branchName = `feature/${issue.gitlabIid ?? issue.id}-${this.slugify(issue.title)}`;

      // Update issue status
      await this.issuesService.update(issueId, { status: IssueStatus.IN_PROGRESS });

      // Update orchestrator task with fix details
      await this.prisma.agentTask.update({
        where: { id: ctx.agentTaskId },
        data: { input: { feedback, feedbackSource } as any },
      });

      const sourceLabel = feedbackSource === 'review' ? 'Code Review'
        : feedbackSource === 'pipeline' ? 'CI/CD Pipeline'
        : 'User Feedback';

      await this.sendAgentMessage(
        ctx,
        `🔧 Fixing issue #${issue.gitlabIid ?? '?'}: **${issue.title}** (${sourceLabel})`,
      );

      // Post fix-start comment
      if (issue.gitlabIid) {
        await postAgentComment({
          prisma: this.prisma,
          gitlabService: this.gitlabService,
          issueId,
          gitlabProjectId: issue.project.gitlabProjectId,
          issueIid: issue.gitlabIid,
          agentTaskId: agentTask.id,
          authorName: 'Coder Agent',
          markdownContent: `## 🔧 Fix in Progress (${sourceLabel})\n\n> ${feedback.substring(0, 500)}`,
        });
      }

      // Checkout existing feature branch
      await this.gitCheckout(workspace, branchName);
      await this.gitPull(workspace);

      // Build fix prompt with feedback context
      const fixPrompt = this.buildFixPrompt(issue, feedback, feedbackSource);

      // Fetch GitLab project info (needed for default branch detection + commit URL)
      const glProject = await this.gitlabService.getProject(issue.project.gitlabProjectId);
      const gitlabBaseUrl = this.settings.gitlabUrl;
      const fixDefaultBranch = issue.project.workBranch || glProject?.default_branch || 'main';

      // Run MCP agent loop (LLM + filesystem tools)
      await this.runMcpAgentLoop(workspace, fixPrompt, agentTask.id, ctx.projectId);

      // Check changes (includes both uncommitted AND committed changes vs base branch)
      const sessionBaseBranch = isSessionIssue && issueSession?.branch ? issueSession.branch : fixDefaultBranch;
      const changedFiles = await this.getChangedFiles(workspace, sessionBaseBranch);

      // If no files were changed, the fix attempt was a no-op — signal failure
      if (changedFiles.length === 0) {
        this.logger.warn(`Fix attempt produced 0 code changes for issue ${issueId}`);
        await this.sendAgentMessage(
          ctx,
          `⚠️ Fix attempt produced no code changes for #${issue.gitlabIid ?? '?'} — skipping review`,
        );

        await this.prisma.agentTask.update({
          where: { id: agentTask.id },
          data: {
            status: AgentTaskStatus.COMPLETED,
            output: { changedFiles: [], feedbackSource, noChanges: true } as any,
            completedAt: new Date(),
          },
        });
        await this.updateStatus(ctx, AgentStatus.IDLE);

        // Emit codingComplete with noChanges flag so orchestrator skips review
        const existingTask = await this.prisma.agentTask.findFirst({
          where: { issueId, gitlabMrIid: { not: null } },
          orderBy: { startedAt: 'desc' },
          select: { gitlabMrIid: true },
        });
        this.eventEmitter.emit('agent.codingComplete', {
          projectId: ctx.projectId,
          chatSessionId: ctx.chatSessionId,
          issueId,
          gitlabIid: issue.gitlabIid,
          mrIid: existingTask?.gitlabMrIid ?? undefined,
          gitlabProjectId: issue.project.gitlabProjectId,
          branch: branchName,
          noChanges: true,
        });

        await this.gitCheckout(workspace, sessionBaseBranch);
        return;
      }

      let commitSha: string | undefined;
      let commitUrl: string | undefined;
      commitSha = await this.gitCommitAndPush(
        workspace,
        branchName,
        `fix: address ${sourceLabel.toLowerCase()} for ${issue.title}`,
      );
      commitUrl = `${gitlabBaseUrl}/${glProject.path_with_namespace}/-/commit/${commitSha}`;

      const commitShort = commitSha?.substring(0, 8);

      // Update issue → IN_REVIEW
      await this.issuesService.update(issueId, { status: IssueStatus.IN_REVIEW });

      // Complete task
      await this.prisma.agentTask.update({
        where: { id: agentTask.id },
        data: {
          status: AgentTaskStatus.COMPLETED,
          output: { changedFiles, feedbackSource, commitSha } as any,
          completedAt: new Date(),
        },
      });

      // Post fix-complete comment
      if (issue.gitlabIid) {
        const fixComment = [
          `## ✅ Fix Applied (${sourceLabel})`,
          '',
          commitUrl ? `**Commit:** [\`${commitShort}\`](${commitUrl}) — [View Diff](${commitUrl})` : '',
          `**Changed files (${changedFiles.length}):**`,
          ...changedFiles.map(f => `- \`${f}\``),
          '',
          '---',
          '_Fixed by Coder Agent_',
        ].filter(Boolean).join('\n');

        await postAgentComment({
          prisma: this.prisma,
          gitlabService: this.gitlabService,
          issueId,
          gitlabProjectId: issue.project.gitlabProjectId,
          issueIid: issue.gitlabIid,
          agentTaskId: agentTask.id,
          authorName: 'Coder Agent',
          markdownContent: fixComment,
        });
      }

      await this.sendAgentMessage(
        ctx,
        `✅ Fix applied for #${issue.gitlabIid ?? '?'} — ${changedFiles.length} file(s) changed`,
      );

      // Find existing MR IID for this issue's branch
      const existingTask = await this.prisma.agentTask.findFirst({
        where: { issueId, gitlabMrIid: { not: null } },
        orderBy: { startedAt: 'desc' },
        select: { gitlabMrIid: true },
      });

      // Re-emit coding complete for review — always emit so the pipeline advances
      const mrIid = existingTask?.gitlabMrIid;
      this.eventEmitter.emit('agent.codingComplete', {
        projectId: ctx.projectId,
        chatSessionId: ctx.chatSessionId,
        issueId,
        gitlabIid: issue.gitlabIid,
        mrIid: mrIid ?? undefined,
        gitlabProjectId: issue.project.gitlabProjectId,
        branch: branchName,
      });
      if (!mrIid) {
        this.logger.warn(`No MR found for fixIssue ${issueId} — codingComplete emitted without MR`);
      }

      // Switch back to base branch (session branch for sessions, default for infra)
      const baseForCheckout = isSessionIssue && issueSession?.branch ? issueSession.branch : glProject.default_branch;
      await this.gitCheckout(workspace, baseForCheckout);

      await this.updateStatus(ctx, AgentStatus.IDLE);

    } catch (err) {
      this.logger.error(`fixIssue failed: ${err.message}`, err.stack);

      // Mark task as FAILED in DB (prevents orphaned RUNNING tasks)
      try {
        await this.prisma.agentTask.update({
          where: { id: agentTask.id },
          data: { status: AgentTaskStatus.FAILED, completedAt: new Date() },
        });
      } catch { /* best effort */ }

      // Do NOT reset issue to OPEN — that causes it to fall out of the pipeline.
      // Instead, emit codingFailed so the orchestrator can retrigger or move to NEEDS_REVIEW.

      await this.sendAgentMessage(ctx, `❌ Fix failed: ${err.message}`);
      await this.updateStatus(ctx, AgentStatus.ERROR);

      // Emit failure event so the orchestrator continues the pipeline
      this.eventEmitter.emit('agent.codingFailed', {
        projectId: ctx.projectId,
        chatSessionId: ctx.chatSessionId,
        issueId,
        isFixAttempt: true,
        errorMessage: err.message,
      });
    }
  }

  // ─── MCP Agent Loop Execution ─────────────────────────────

  /**
   * Run the MCP agent loop: LLM + filesystem tools.
   * The LLM reads, writes, and edits files via MCP server.
   * Returns the final LLM summary.
   */
  private async runMcpAgentLoop(workspace: string, prompt: string, agentTaskId: string, projectId?: string): Promise<string> {
    const config = this.getRoleConfig();
    const model = config.model || 'qwen3.5:35b';

    const mcpServers = await this.mcpRegistry.resolveServersForRole(
      AgentRole.CODER,
      { workspace, allowedPaths: [workspace], projectId },
    );

    // Read project knowledge base for context
    const knowledgeSection = await this.buildKnowledgeSection(workspace);

    const systemPrompt = [
      'You are a skilled software developer. Your task is to implement features by reading and modifying files in the project.',
      '',
      `IMPORTANT — Working Directory: ${workspace}`,
      'You are ALREADY inside the project directory. All files exist directly here.',
      'All file operations MUST use paths RELATIVE to this directory.',
      'Example: To create "src/main.ts", use path "src/main.ts" — NOT "project-name/src/main.ts".',
      'NEVER use absolute paths like "/home/..." — always use relative paths from the project root.',
      'NEVER create a subfolder named after the project. Files go directly into the current directory.',
      '',
      'Available tools:',
      '- File tools: browse directories, read/write/edit files, search',
      '- Shell tool (run_command): execute commands like npm install, npm audit fix, git status, etc.',
      '  Shell commands run in the project root directory automatically.',
      '',
      'Workflow:',
      '1. First, explore the project structure using list_directory with path "."',
      '2. Read relevant files to understand existing code patterns',
      '3. Implement the requested changes by writing or editing files (RELATIVE paths only!)',
      '4. Install dependencies after adding them:',
      '   - npm/Node.js: run "npm install" after modifying package.json',
      '   - Maven/Java: dependencies in pom.xml are resolved automatically on build; run "mvn compile" to verify',
      '   - Gradle: run "gradle build" after modifying build.gradle',
      '5. Verify your changes are consistent with the existing codebase',
      '',
      'Java/Vaadin/Spring Boot specifics:',
      '- Follow standard Maven directory layout: src/main/java, src/main/resources, src/test/java',
      '- Use Spring annotations: @Service, @Repository, @RestController, @Entity, etc.',
      '- For Vaadin Flow views: extend com.vaadin.flow.component classes, use @Route annotation',
      '- For JPA entities: use @Entity, @Table, @Column annotations with proper relationships',
      '- For Flyway migrations: create SQL files in src/main/resources/db/migration/ with naming V{N}__{description}.sql',
      '- application.properties/yml goes in src/main/resources/',
      '- Do NOT modify the Maven wrapper (mvnw) files',
      '',
      'Rules:',
      '- ALWAYS use relative paths (e.g., "src/app.ts", "src/main/java/com/example/MyClass.java")',
      '- Follow existing code patterns and conventions',
      '- Reuse existing services, components, and utilities — do NOT duplicate code',
      '- Add error handling where appropriate',
      '- Do NOT create test files unless the task specifically asks for tests',
      '- Do NOT modify unrelated files',
      '- If asked to fix security vulnerabilities, use "npm audit fix" or update dependency versions in pom.xml/package.json',
      '- When done, respond with a brief summary of what you changed',
      knowledgeSection,
    ].join('\n');

    this.logger.log(`Starting MCP agent loop in ${workspace} with model ${model}`);

    const result = await this.mcpAgentLoop.run({
      provider: config.provider,
      model,
      systemPrompt,
      userPrompt: prompt,
      mcpServers,
      maxIterations: 30,
      temperature: config.parameters.temperature,
      maxTokens: config.parameters.maxTokens,
      agentTaskId,
      cwd: workspace,
      onToolCall: (name, args) => {
        this.logger.debug(`Tool call: ${name}(${JSON.stringify(args).substring(0, 150)})`);
      },
      onIteration: (iteration) => {
        this.logger.debug(`Agent loop iteration ${iteration}`);
      },
    });

    this.logger.log(
      `MCP agent loop finished: ${result.finishReason}, ${result.iterations} iterations, ${result.toolCallsExecuted} tool calls, ${result.durationMs}ms`,
    );

    if (result.finishReason === 'error' && result.toolCallsExecuted === 0) {
      throw new Error('MCP agent loop failed — LLM returned no usable output');
    }

    return result.content;
  }

  // ─── Prompt Builders ──────────────────────────────────────

  private buildCodingPrompt(issue: any): string {
    const parts: string[] = [
      `Implement the following feature:`,
      '',
      `## ${issue.title}`,
      '',
      issue.description || 'No description provided.',
    ];

    if (issue.subIssues?.length > 0) {
      parts.push('', '## Sub-tasks:');
      for (const sub of issue.subIssues) {
        parts.push(`- ${sub.title}${sub.description ? `: ${sub.description}` : ''}`);
      }
    }

    return parts.join('\n');
  }

  private buildFixPrompt(issue: any, feedback: string, source: string): string {
    const sourceLabel: Record<string, string> = {
      'review': 'Code Review',
      'functional-test': 'Functional Test',
      'ui-test': 'UI Test',
      'security': 'Security/Pen Test',
      'pipeline': 'Pipeline',
      'user': 'User Feedback',
    };

    const parts: string[] = [
      `# Fix Required: ${issue.title}`,
      '',
      `## Context`,
      issue.description || 'No description provided.',
      '',
      `## ${sourceLabel[source] || source} Findings`,
      '',
      `The following issues were found by the **${sourceLabel[source] || source}** and MUST be fixed:`,
      '',
      feedback,
      '',
      `## Fix Instructions`,
      '',
      `1. Read each finding carefully — pay attention to file paths, line numbers, and severity levels`,
      `2. For CRITICAL/HIGH severity: these MUST be fixed, they are blocking`,
      `3. For WARNING/MEDIUM severity: fix these too, they will cause the review to fail again`,
      `4. For each finding: open the mentioned file, locate the issue, and make a concrete code change`,
      `5. Do NOT just add comments or TODOs — make actual code fixes`,
      `6. After fixing, verify your changes don't break existing functionality`,
      '',
      `IMPORTANT: Previous fix attempts for this issue may have failed. Make sure you actually change the relevant source files. A fix attempt that produces 0 file changes will be rejected.`,
    ];

    return parts.join('\n');
  }

  // ─── Git Helpers ──────────────────────────────────────────

  private async gitPull(cwd: string): Promise<void> {
    try {
      await execFileAsync('git', ['pull', '--ff-only'], { cwd, timeout: GIT_TIMEOUT_MS });
    } catch (err) {
      this.logger.debug(`git pull failed (non-fatal): ${err.message}`);
    }
  }

  private async gitCheckout(cwd: string, branch: string): Promise<void> {
    // Stash any uncommitted AND untracked changes before switching branches
    try {
      const { stdout: status } = await execFileAsync('git', ['status', '--porcelain'], { cwd, timeout: GIT_TIMEOUT_MS });
      if (status.trim()) {
        this.logger.debug(`Stashing ${status.trim().split('\n').length} changes (incl. untracked) before checkout ${branch}`);
        await execFileAsync('git', ['stash', 'push', '--include-untracked', '-m', `auto-stash before checkout ${branch}`], { cwd, timeout: GIT_TIMEOUT_MS });
      }
    } catch (stashErr) {
      this.logger.warn(`git stash failed: ${stashErr.message}`);
    }
    await execFileAsync('git', ['checkout', branch], { cwd, timeout: GIT_TIMEOUT_MS });
  }

  private async gitCreateBranch(cwd: string, branch: string): Promise<void> {
    try {
      await execFileAsync('git', ['checkout', '-b', branch], { cwd, timeout: GIT_TIMEOUT_MS });
    } catch {
      // Branch may already exist — try to check it out
      await execFileAsync('git', ['checkout', branch], { cwd, timeout: GIT_TIMEOUT_MS });
    }
  }

  /**
   * Get changed files — checks both uncommitted changes (git status) AND
   * committed changes vs default branch (git diff). CLI providers like Codex
   * commit changes directly, so git status alone returns empty.
   */
  private async getChangedFiles(cwd: string, defaultBranch = 'main'): Promise<string[]> {
    const files = new Set<string>();

    // 1. Uncommitted changes (for MCP/API providers that don't commit)
    try {
      const { stdout } = await execFileAsync(
        'git', ['status', '--porcelain'],
        { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
      );
      for (const line of stdout.trim().split('\n')) {
        if (line.trim()) files.add(line.substring(3).trim());
      }
    } catch { /* ignore */ }

    // 2. Committed changes vs default branch (for CLI providers that auto-commit)
    try {
      const { stdout } = await execFileAsync(
        'git', ['diff', '--name-only', defaultBranch + '...HEAD'],
        { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
      );
      for (const line of stdout.trim().split('\n')) {
        if (line.trim()) files.add(line.trim());
      }
    } catch (err) {
      this.logger.debug(`git diff vs ${defaultBranch} failed: ${err.message}`);
    }

    return [...files];
  }

  /**
   * Commit uncommitted changes (if any) and push the branch.
   * CLI providers may already have committed — in that case we skip the commit
   * and just push their commits.
   */
  private async gitCommitAndPush(cwd: string, branch: string, message: string): Promise<string> {
    // Stage and commit any uncommitted changes (may be empty for CLI providers)
    await execFileAsync('git', ['add', '.'], { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 });
    try {
      await execFileAsync('git', ['commit', '-m', message], { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 });
    } catch (commitErr) {
      // "nothing to commit" is fine — CLI provider already committed
      // Check message, stdout, AND stderr since Node distributes the text across properties
      const errText = [commitErr.message, commitErr.stdout, commitErr.stderr].filter(Boolean).join(' ');
      if (!errText.includes('nothing to commit') && !errText.includes('nichts zu committen')) {
        throw commitErr;
      }
      this.logger.debug('No uncommitted changes to commit — CLI provider likely already committed');
    }

    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd, timeout: GIT_TIMEOUT_MS });
    const commitSha = stdout.trim();

    await execFileAsync(
      'git', ['push', '-u', 'origin', branch],
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
    );
    return commitSha;
  }

  // ─── Utility ──────────────────────────────────────────────

  /** Slug from issue title for branch names */
  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .substring(0, 40);
  }

  private async markFailed(ctx: AgentContext, reason: string): Promise<void> {
    try {
      await this.updateStatus(ctx, AgentStatus.ERROR);
      await this.log(ctx.agentTaskId, 'ERROR', `Coder failed: ${reason}`);
    } catch (err) {
      this.logger.error(`Failed to mark task as failed: ${err.message}`);
    }
  }
}
