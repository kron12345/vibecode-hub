import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
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
import { BaseAgent, AgentContext, sanitizeJsonOutput } from '../agent-base';
import { MonitorGateway } from '../../monitor/monitor.gateway';
import { postAgentComment } from '../agent-comment.utils';
import { CoderIssueResult } from './coder-result.interface';
import { buildCodingPrompt, buildFixPrompt, runMcpAgentLoop, McpLoopDeps } from './coder-prompt';
import {
  slugify,
  gitPull,
  gitCheckout,
  gitCreateBranch,
  getChangedFiles,
  gitCommitAndPush,
} from './coder-git';
import {
  AgentRole,
  AgentStatus,
  AgentTaskStatus,
  ChatSessionType,
  IssueStatus,
} from '@prisma/client';

@Injectable()
export class CoderAgent extends BaseAgent {
  readonly role = AgentRole.CODER;
  protected readonly logger = new Logger(CoderAgent.name);

  /** Lazily built deps object for the extracted MCP loop function */
  private mcpLoopDeps: McpLoopDeps | null = null;

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

  /** Build (and cache) the deps bag for the extracted runMcpAgentLoop */
  private getMcpLoopDeps(): McpLoopDeps {
    if (!this.mcpLoopDeps) {
      this.mcpLoopDeps = {
        prisma: this.prisma,
        mcpAgentLoop: this.mcpAgentLoop,
        mcpRegistry: this.mcpRegistry,
        wikiReader: this.gitlabService,
        logger: this.logger,
        getRoleConfig: () => this.getRoleConfig(),
        buildKnowledgeSectionWiki: (wr, gpid, ws) =>
          this.buildKnowledgeSectionWiki(wr, gpid, ws),
      };
    }
    return this.mcpLoopDeps;
  }

  // ─── Main Entry: Milestone Coding ──────────────────────────

  async runMilestoneCoding(ctx: AgentContext): Promise<void> {
    try {
      await this.updateStatus(ctx, AgentStatus.WORKING);

      const project = await this.prisma.project.findUnique({
        where: { id: ctx.projectId },
      });
      if (!project?.gitlabProjectId) {
        await this.sendAgentMessage(ctx, '❌ Project has no GitLab repo linked');
        await this.markFailed(ctx, 'No GitLab repo linked');
        return;
      }

      let chatSessionFilter: { chatSessionId?: string } = {};
      if (ctx.chatSessionId) {
        const session = await this.prisma.chatSession.findUnique({
          where: { id: ctx.chatSessionId },
          select: { type: true },
        });
        if (session?.type === ChatSessionType.DEV_SESSION) {
          chatSessionFilter = { chatSessionId: ctx.chatSessionId };
        }
      }

      const workspace = await this.resolveWorkspace(project.slug, ctx.chatSessionId);
      await gitPull(workspace, this.getGitTimeoutMs(), this.logger);

      const milestones = await this.prisma.milestone.findMany({
        where: {
          projectId: ctx.projectId,
          issues: { some: { status: IssueStatus.OPEN, parentId: null, ...chatSessionFilter } },
        },
        include: {
          issues: {
            where: { parentId: null, status: IssueStatus.OPEN, ...chatSessionFilter },
            include: { subIssues: { orderBy: { sortOrder: 'asc' } } },
            orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
            take: 1,
          },
        },
        orderBy: { sortOrder: 'asc' },
        take: 1,
      });

      if (milestones.length === 0 || milestones[0].issues.length === 0) {
        await this.sendAgentMessage(ctx, '📭 No open issues found — all done!');
        await this.updateStatus(ctx, AgentStatus.IDLE);
        return;
      }

      const issue = milestones[0].issues[0];
      const remainingCount = await this.prisma.issue.count({
        where: { projectId: ctx.projectId, status: IssueStatus.OPEN, parentId: null, ...chatSessionFilter },
      });

      await this.sendAgentMessage(
        ctx,
        `💻 **Coder Agent** — processing issue #${issue.gitlabIid ?? '?'}: **${issue.title}** (${remainingCount} remaining)`,
      );

      const glProject = await this.gitlabService.getProject(project.gitlabProjectId);
      const defaultBranch = project.workBranch || glProject.default_branch;

      const chatSession = ctx.chatSessionId
        ? await this.prisma.chatSession.findUnique({
            where: { id: ctx.chatSessionId },
            select: { branch: true, type: true },
          })
        : null;
      const sessionBranch = chatSession?.type === 'DEV_SESSION' ? chatSession.branch : null;

      const issueResult = await this.processIssue(
        ctx, issue, workspace, project.gitlabProjectId,
        defaultBranch, glProject.path_with_namespace, sessionBranch,
      );

      const emoji = issueResult.status === 'success' ? '✅' : issueResult.status === 'failed' ? '❌' : '⏭️';
      await this.sendAgentMessage(
        ctx,
        `${emoji} Issue #${issue.gitlabIid ?? '?'} ${issueResult.status}${issueResult.mrIid ? ` — MR !${issueResult.mrIid}` : ''} (${remainingCount - 1} issues remaining)`,
      );

      if (issueResult.status === 'failed') {
        this.eventEmitter.emit('agent.codingFailed', {
          projectId: ctx.projectId, chatSessionId: ctx.chatSessionId,
          issueId: issue.id, errorMessage: issueResult.error,
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
    ctx: AgentContext, issue: any, workspace: string,
    gitlabProjectId: number, defaultBranch: string,
    projectPath: string, sessionBranch?: string | null,
  ): Promise<CoderIssueResult> {
    const start = Date.now();
    const branchName = `feature/${issue.gitlabIid ?? issue.id}-${slugify(issue.title)}`;
    const baseBranch = sessionBranch || defaultBranch;
    const timeout = this.getGitTimeoutMs();
    const result: CoderIssueResult = {
      issueId: issue.id, gitlabIid: issue.gitlabIid,
      branch: branchName, filesChanged: [], status: 'failed', durationMs: 0,
    };
    const taskId = ctx.agentTaskId;

    try {
      await this.issuesService.update(issue.id, { status: IssueStatus.IN_PROGRESS });
      await this.prisma.agentTask.update({ where: { id: taskId }, data: { issueId: issue.id } });

      await this.sendAgentMessage(ctx, `🔨 Coding issue #${issue.gitlabIid ?? '?'}: **${issue.title}**`);

      if (issue.gitlabIid && gitlabProjectId) {
        await postAgentComment({
          prisma: this.prisma, gitlabService: this.gitlabService,
          issueId: issue.id, gitlabProjectId, issueIid: issue.gitlabIid,
          agentTaskId: taskId, authorName: 'Coder Agent',
          markdownContent: `## 🤖 Coder Agent Starting\n\nBranch: \`${branchName}\``,
        });
      }

      await gitCheckout(workspace, baseBranch, timeout, this.logger);
      await gitPull(workspace, timeout, this.logger);
      await gitCreateBranch(workspace, branchName, timeout);

      await this.log(taskId, 'INFO', `Running MCP agent loop for issue: ${issue.title}`);
      await runMcpAgentLoop(this.getMcpLoopDeps(), workspace, buildCodingPrompt(issue), taskId, ctx.projectId);

      const changedFiles = await getChangedFiles(workspace, baseBranch, timeout, this.logger);
      result.filesChanged = changedFiles;

      if (changedFiles.length === 0) {
        return this.handleNoChanges(ctx, issue, workspace, baseBranch, branchName, gitlabProjectId, taskId, result, start);
      }

      const commitSha = await gitCommitAndPush(
        workspace, branchName,
        `feat: implement ${issue.title}\n\nCloses #${issue.gitlabIid ?? ''}`,
        timeout, this.logger,
      );

      if (gitlabProjectId) {
        await this.createOrFindMr(branchName, baseBranch, issue, gitlabProjectId, changedFiles, taskId, result);
      }

      await this.issuesService.update(issue.id, { status: IssueStatus.IN_REVIEW });

      const gitlabBaseUrl = this.settings.gitlabUrl;
      const commitUrl = `${gitlabBaseUrl}/${projectPath}/-/commit/${commitSha}`;
      result.commitSha = commitSha;
      result.commitUrl = commitUrl;

      if (issue.gitlabIid && gitlabProjectId) {
        await this.postImplementationComment(issue, gitlabProjectId, taskId, branchName, commitSha, commitUrl, changedFiles, result);
      }

      await this.prisma.agentTask.update({
        where: { id: taskId },
        data: { status: AgentTaskStatus.COMPLETED, output: sanitizeJsonOutput(result) as any, completedAt: new Date() },
      });

      result.status = 'success';
      result.durationMs = Date.now() - start;

      this.eventEmitter.emit('agent.codingComplete', {
        projectId: ctx.projectId, chatSessionId: ctx.chatSessionId,
        issueId: issue.id, gitlabIid: issue.gitlabIid,
        mrIid: result.mrIid, gitlabProjectId, branch: branchName,
      });
      if (!result.mrIid) {
        this.logger.warn(`No MR created for issue ${issue.gitlabIid} — codingComplete emitted without MR`);
      }

      await gitCheckout(workspace, baseBranch, timeout, this.logger);
      return result;
    } catch (err) {
      return this.handleProcessError(ctx, err, issue, workspace, baseBranch, timeout, taskId, result, start);
    }
  }

  // ─── Fix Issue (re-trigger from review/pipeline/user) ──────

  async fixIssue(
    ctx: AgentContext, issueId: string,
    feedback: string, feedbackSource: 'review' | 'pipeline' | 'user',
  ): Promise<void> {
    const taskId = ctx.agentTaskId;

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
      const branchName = `feature/${issue.gitlabIid ?? issue.id}-${slugify(issue.title)}`;
      const timeout = this.getGitTimeoutMs();

      await this.issuesService.update(issueId, { status: IssueStatus.IN_PROGRESS });
      await this.prisma.agentTask.update({
        where: { id: taskId },
        data: { input: { feedback, feedbackSource } as any },
      });

      const sourceLabel = feedbackSource === 'review' ? 'Code Review'
        : feedbackSource === 'pipeline' ? 'CI/CD Pipeline' : 'User Feedback';

      await this.sendAgentMessage(
        ctx, `🔧 Fixing issue #${issue.gitlabIid ?? '?'}: **${issue.title}** (${sourceLabel})`,
      );

      if (issue.gitlabIid) {
        await postAgentComment({
          prisma: this.prisma, gitlabService: this.gitlabService,
          issueId, gitlabProjectId: issue.project.gitlabProjectId,
          issueIid: issue.gitlabIid, agentTaskId: taskId,
          authorName: 'Coder Agent',
          markdownContent: `## 🔧 Fix in Progress (${sourceLabel})\n\n> ${feedback.substring(0, 5000)}`,
        });
      }

      await gitCheckout(workspace, branchName, timeout, this.logger);
      await gitPull(workspace, timeout, this.logger);

      const glProject = await this.gitlabService.getProject(issue.project.gitlabProjectId);
      const fixDefaultBranch = issue.project.workBranch || glProject?.default_branch || 'main';
      const sessionBaseBranch = isSessionIssue && issueSession?.branch
        ? issueSession.branch : fixDefaultBranch;

      await runMcpAgentLoop(
        this.getMcpLoopDeps(), workspace,
        buildFixPrompt(issue, feedback, feedbackSource), taskId, ctx.projectId,
      );

      const changedFiles = await getChangedFiles(workspace, sessionBaseBranch, timeout, this.logger);

      if (changedFiles.length === 0) {
        await this.handleFixNoChanges(
          ctx, issue, issueId, branchName, feedbackSource,
          issue.project.gitlabProjectId, workspace, sessionBaseBranch, timeout, taskId,
        );
        return;
      }

      const commitSha = await gitCommitAndPush(
        workspace, branchName,
        `fix: address ${sourceLabel.toLowerCase()} for ${issue.title}`,
        timeout, this.logger,
      );
      const gitlabBaseUrl = this.settings.gitlabUrl;
      const commitUrl = `${gitlabBaseUrl}/${glProject.path_with_namespace}/-/commit/${commitSha}`;
      const commitShort = commitSha.substring(0, 8);

      await this.issuesService.update(issueId, { status: IssueStatus.IN_REVIEW });

      await this.prisma.agentTask.update({
        where: { id: taskId },
        data: {
          status: AgentTaskStatus.COMPLETED,
          output: sanitizeJsonOutput({ changedFiles, feedbackSource, commitSha }) as any,
          completedAt: new Date(),
        },
      });

      if (issue.gitlabIid) {
        const fixComment = [
          `## ✅ Fix Applied (${sourceLabel})`, '',
          commitUrl ? `**Commit:** [\`${commitShort}\`](${commitUrl}) — [View Diff](${commitUrl})` : '',
          `**Changed files (${changedFiles.length}):**`,
          ...changedFiles.map((f) => `- \`${f}\``),
          '', '---', '_Fixed by Coder Agent_',
        ].filter(Boolean).join('\n');

        await postAgentComment({
          prisma: this.prisma, gitlabService: this.gitlabService,
          issueId, gitlabProjectId: issue.project.gitlabProjectId,
          issueIid: issue.gitlabIid, agentTaskId: taskId,
          authorName: 'Coder Agent', markdownContent: fixComment,
        });
      }

      await this.sendAgentMessage(ctx, `✅ Fix applied for #${issue.gitlabIid ?? '?'} — ${changedFiles.length} file(s) changed`);

      const existingTask = await this.prisma.agentTask.findFirst({
        where: { issueId, gitlabMrIid: { not: null } },
        orderBy: { startedAt: 'desc' },
        select: { gitlabMrIid: true },
      });
      const mrIid = existingTask?.gitlabMrIid;
      this.eventEmitter.emit('agent.codingComplete', {
        projectId: ctx.projectId, chatSessionId: ctx.chatSessionId,
        issueId, gitlabIid: issue.gitlabIid, mrIid: mrIid ?? undefined,
        gitlabProjectId: issue.project.gitlabProjectId, branch: branchName,
      });
      if (!mrIid) {
        this.logger.warn(`No MR found for fixIssue ${issueId} — codingComplete emitted without MR`);
      }

      const baseForCheckout = isSessionIssue && issueSession?.branch ? issueSession.branch : glProject.default_branch;
      await gitCheckout(workspace, baseForCheckout, timeout, this.logger);
      await this.updateStatus(ctx, AgentStatus.IDLE);
    } catch (err) {
      this.logger.error(`fixIssue failed: ${err.message}`, err.stack);
      try {
        await this.prisma.agentTask.update({
          where: { id: taskId },
          data: { status: AgentTaskStatus.FAILED, completedAt: new Date() },
        });
      } catch { /* best effort */ }

      await this.sendAgentMessage(ctx, `❌ Fix failed: ${err.message}`);
      await this.updateStatus(ctx, AgentStatus.ERROR);

      this.eventEmitter.emit('agent.codingFailed', {
        projectId: ctx.projectId, chatSessionId: ctx.chatSessionId,
        issueId, isFixAttempt: true, errorMessage: err.message,
      });
    }
  }

  // ─── Private Helpers ───────────────────────────────────────

  /** Handle processIssue when agent produced zero file changes */
  private async handleNoChanges(
    ctx: AgentContext, issue: any, workspace: string,
    baseBranch: string, branchName: string, gitlabProjectId: number,
    taskId: string, result: CoderIssueResult, start: number,
  ): Promise<CoderIssueResult> {
    const timeout = this.getGitTimeoutMs();
    await this.sendAgentMessage(
      ctx, `⚠️ Agent produced no file changes for #${issue.gitlabIid ?? '?'} — marking for manual review`,
    );
    result.status = 'skipped';
    await gitCheckout(workspace, baseBranch, timeout, this.logger);
    await this.issuesService.update(issue.id, { status: IssueStatus.NEEDS_REVIEW });
    await this.prisma.agentTask.update({
      where: { id: taskId },
      data: { status: AgentTaskStatus.COMPLETED, completedAt: new Date() },
    });
    this.eventEmitter.emit('agent.codingComplete', {
      projectId: ctx.projectId, chatSessionId: ctx.chatSessionId,
      issueId: issue.id, gitlabIid: issue.gitlabIid,
      mrIid: undefined, gitlabProjectId, branch: branchName,
    });
    result.durationMs = Date.now() - start;
    return result;
  }

  /** Handle fixIssue when fix attempt produced zero code changes */
  private async handleFixNoChanges(
    ctx: AgentContext, issue: any, issueId: string,
    branchName: string, feedbackSource: string,
    gitlabProjectId: number, workspace: string,
    sessionBaseBranch: string, timeout: number, taskId: string,
  ): Promise<void> {
    this.logger.warn(`Fix attempt produced 0 code changes for issue ${issueId}`);
    await this.sendAgentMessage(
      ctx, `⚠️ Fix attempt produced no code changes for #${issue.gitlabIid ?? '?'} — skipping review`,
    );
    await this.prisma.agentTask.update({
      where: { id: taskId },
      data: {
        status: AgentTaskStatus.COMPLETED,
        output: { changedFiles: [], feedbackSource, noChanges: true } as any,
        completedAt: new Date(),
      },
    });
    await this.updateStatus(ctx, AgentStatus.IDLE);

    const existingTask = await this.prisma.agentTask.findFirst({
      where: { issueId, gitlabMrIid: { not: null } },
      orderBy: { startedAt: 'desc' },
      select: { gitlabMrIid: true },
    });
    this.eventEmitter.emit('agent.codingComplete', {
      projectId: ctx.projectId, chatSessionId: ctx.chatSessionId,
      issueId, gitlabIid: issue.gitlabIid,
      mrIid: existingTask?.gitlabMrIid ?? undefined,
      gitlabProjectId, branch: branchName, noChanges: true,
    });
    await gitCheckout(workspace, sessionBaseBranch, timeout, this.logger);
  }

  /** Create MR or find existing one on 409 conflict */
  private async createOrFindMr(
    branchName: string, baseBranch: string, issue: any,
    gitlabProjectId: number, changedFiles: string[],
    taskId: string, result: CoderIssueResult,
  ): Promise<void> {
    try {
      const mr = await this.gitlabService.createMergeRequest(gitlabProjectId, {
        source_branch: branchName, target_branch: baseBranch,
        title: `feat: ${issue.title}`,
        description: `Closes #${issue.gitlabIid ?? ''}\n\n---\n_Automatically created by Coder Agent_\n\n**Changed files:** ${changedFiles.length}\n${changedFiles.map((f) => `- \`${f}\``).join('\n')}`,
      });
      result.mrIid = mr.iid;
      result.mrUrl = mr.web_url;
      await this.prisma.agentTask.update({ where: { id: taskId }, data: { gitlabMrIid: mr.iid } });
    } catch (mrErr) {
      if (mrErr?.response?.status === 409 || mrErr?.message?.includes('409')) {
        this.logger.log(`MR already exists for ${branchName}, looking up existing MR`);
        const existingMr = await this.gitlabService.findMergeRequestByBranch(gitlabProjectId, branchName);
        if (existingMr) {
          result.mrIid = existingMr.iid;
          result.mrUrl = existingMr.web_url;
          await this.prisma.agentTask.update({ where: { id: taskId }, data: { gitlabMrIid: existingMr.iid } });
          this.logger.log(`Found existing MR !${existingMr.iid} for ${branchName}`);
        } else {
          this.logger.warn(`MR creation failed with 409 but no existing MR found for ${branchName}`);
          await this.log(taskId, 'WARN', `MR creation failed: ${mrErr.message}`);
        }
      } else {
        this.logger.warn(`MR creation failed: ${mrErr.message}`);
        await this.log(taskId, 'WARN', `MR creation failed: ${mrErr.message}`);
      }
    }
  }

  /** Post implementation-complete comment to GitLab */
  private async postImplementationComment(
    issue: any, gitlabProjectId: number, taskId: string,
    branchName: string, commitSha: string, commitUrl: string,
    changedFiles: string[], result: CoderIssueResult,
  ): Promise<void> {
    const commitShort = commitSha.substring(0, 8);
    const commentBody = [
      `## 🔨 Implementation Complete`, '',
      `**Commit:** [\`${commitShort}\`](${commitUrl}) — [View Diff](${commitUrl})`,
      `**Branch:** \`${branchName}\``,
      result.mrUrl ? `**MR:** [!${result.mrIid}](${result.mrUrl})` : '',
      `**Changed files (${changedFiles.length}):**`,
      ...changedFiles.map((f) => `- \`${f}\``),
      '', '---', '_Implemented by Coder Agent_',
    ].filter(Boolean).join('\n');

    await postAgentComment({
      prisma: this.prisma, gitlabService: this.gitlabService,
      issueId: issue.id, gitlabProjectId, issueIid: issue.gitlabIid,
      agentTaskId: taskId, authorName: 'Coder Agent',
      markdownContent: commentBody,
    });
  }

  /** Handle processIssue catch block */
  private async handleProcessError(
    ctx: AgentContext, err: any, issue: any, workspace: string,
    baseBranch: string, timeout: number, taskId: string,
    result: CoderIssueResult, start: number,
  ): Promise<CoderIssueResult> {
    this.logger.error(`processIssue failed for ${issue.title}: ${err.message}`);
    result.error = err.message;
    result.status = 'failed';
    result.durationMs = Date.now() - start;

    try {
      await this.prisma.agentTask.update({
        where: { id: taskId },
        data: { status: AgentTaskStatus.FAILED, completedAt: new Date(), output: sanitizeJsonOutput(result) as any },
      });
    } catch { /* best effort */ }

    await this.sendAgentMessage(ctx, `❌ Failed to code issue #${issue.gitlabIid ?? '?'}: ${err.message}`);
    try { await this.issuesService.update(issue.id, { status: IssueStatus.OPEN }); } catch { /* best effort */ }
    try { await gitCheckout(workspace, baseBranch, timeout, this.logger); } catch { /* best effort */ }

    return result;
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
