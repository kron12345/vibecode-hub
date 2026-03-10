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

      // Resolve workspace path
      const workspace = path.resolve(this.settings.devopsWorkspacePath, project.slug);

      // Pull latest on base branch
      await this.gitPull(workspace);

      // Find the NEXT open issue (first by milestone sortOrder, then by issue sortOrder)
      // Sequential strategy: we only process ONE issue at a time.
      // After the full pipeline (Review → Test → Docs → Merge), the orchestrator triggers us again.
      const milestones = await this.prisma.milestone.findMany({
        where: {
          projectId: ctx.projectId,
          issues: {
            some: {
              status: IssueStatus.OPEN,
              parentId: null,
            },
          },
        },
        include: {
          issues: {
            where: { parentId: null, status: IssueStatus.OPEN },
            include: {
              subIssues: { orderBy: { sortOrder: 'asc' } },
            },
            orderBy: { sortOrder: 'asc' },
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
        where: { projectId: ctx.projectId, status: IssueStatus.OPEN, parentId: null },
      });

      await this.sendAgentMessage(
        ctx,
        `💻 **Coder Agent** — processing issue #${issue.gitlabIid ?? '?'}: **${issue.title}** (${remainingCount} remaining)`,
      );

      // Get the base branch: prefer project.workBranch (e.g. "develop"), fallback to GitLab default
      const glProject = await this.gitlabService.getProject(project.gitlabProjectId);
      const defaultBranch = project.workBranch || glProject.default_branch;

      const issueResult = await this.processIssue(ctx, issue, workspace, project.gitlabProjectId, defaultBranch, glProject.path_with_namespace);

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
  ): Promise<CoderIssueResult> {
    const start = Date.now();
    const branchName = `feature/${issue.gitlabIid ?? issue.id}-${this.slugify(issue.title)}`;
    const result: CoderIssueResult = {
      issueId: issue.id,
      gitlabIid: issue.gitlabIid,
      branch: branchName,
      filesChanged: [],
      status: 'failed',
      durationMs: 0,
    };

    let agentTask: { id: string } | null = null;

    try {
      // Update issue status
      await this.issuesService.update(issue.id, { status: IssueStatus.IN_PROGRESS });

      // Create agent task
      agentTask = await this.prisma.agentTask.create({
        data: {
          agentId: ctx.agentInstanceId,
          issueId: issue.id,
          type: AgentTaskType.WRITE_CODE,
          status: AgentTaskStatus.RUNNING,
          startedAt: new Date(),
        },
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

      // Checkout default branch and create feature branch
      await this.gitCheckout(workspace, defaultBranch);
      await this.gitPull(workspace);
      await this.gitCreateBranch(workspace, branchName);

      // Build the coding prompt
      const prompt = this.buildCodingPrompt(issue);

      // Run MCP agent loop (LLM + filesystem tools)
      await this.log(agentTask.id, 'INFO', `Running MCP agent loop for issue: ${issue.title}`);
      await this.runMcpAgentLoop(workspace, prompt, agentTask.id, ctx.projectId);

      // Check what changed (includes both uncommitted AND committed changes vs default branch)
      const changedFiles = await this.getChangedFiles(workspace, defaultBranch);
      result.filesChanged = changedFiles;

      if (changedFiles.length === 0) {
        await this.sendAgentMessage(ctx, `⚠️ Agent produced no file changes for #${issue.gitlabIid ?? '?'} — marking for manual review`);
        result.status = 'skipped';
        await this.gitCheckout(workspace, defaultBranch);

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

      // Create MR
      if (gitlabProjectId) {
        try {
          const mr = await this.gitlabService.createMergeRequest(gitlabProjectId, {
            source_branch: branchName,
            target_branch: defaultBranch,
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
      const gitlabBaseUrl = await this.settings.get('GITLAB_URL', 'https://git.example.com');
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

      // Switch back to default branch for next issue
      await this.gitCheckout(workspace, defaultBranch);

      return result;

    } catch (err) {
      this.logger.error(`processIssue failed for ${issue.title}: ${err.message}`);
      result.error = err.message;
      result.status = 'failed';
      result.durationMs = Date.now() - start;

      // Mark task as FAILED in DB (prevents orphaned RUNNING tasks)
      if (agentTask) {
        try {
          await this.prisma.agentTask.update({
            where: { id: agentTask.id },
            data: { status: AgentTaskStatus.FAILED, completedAt: new Date(), output: result as any },
          });
        } catch { /* best effort */ }
      }

      await this.sendAgentMessage(
        ctx,
        `❌ Failed to code issue #${issue.gitlabIid ?? '?'}: ${err.message}`,
      );

      // Reset issue status so it can be retried
      try {
        await this.issuesService.update(issue.id, { status: IssueStatus.OPEN });
      } catch { /* best effort */ }

      // Try to switch back to default branch
      try {
        await this.gitCheckout(workspace, defaultBranch);
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
    let agentTask: { id: string } | null = null;

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

      const workspace = path.resolve(this.settings.devopsWorkspacePath, issue.project.slug);
      const branchName = `feature/${issue.gitlabIid ?? issue.id}-${this.slugify(issue.title)}`;

      // Update issue status
      await this.issuesService.update(issueId, { status: IssueStatus.IN_PROGRESS });

      // Create fix task
      agentTask = await this.prisma.agentTask.create({
        data: {
          agentId: ctx.agentInstanceId,
          issueId,
          type: AgentTaskType.FIX_CODE,
          status: AgentTaskStatus.RUNNING,
          startedAt: new Date(),
          input: { feedback, feedbackSource } as any,
        },
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
      const gitlabBaseUrl = await this.settings.get('GITLAB_URL', 'https://git.example.com');
      const fixDefaultBranch = issue.project.workBranch || glProject?.default_branch || 'main';

      // Run MCP agent loop (LLM + filesystem tools)
      await this.runMcpAgentLoop(workspace, fixPrompt, agentTask.id, ctx.projectId);

      // Check changes (includes both uncommitted AND committed changes vs default branch)
      const changedFiles = await this.getChangedFiles(workspace, fixDefaultBranch);

      let commitSha: string | undefined;
      let commitUrl: string | undefined;
      if (changedFiles.length > 0) {
        commitSha = await this.gitCommitAndPush(
          workspace,
          branchName,
          `fix: address ${sourceLabel.toLowerCase()} for ${issue.title}`,
        );
        commitUrl = `${gitlabBaseUrl}/${glProject.path_with_namespace}/-/commit/${commitSha}`;
      }

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

      // Switch back to default
      await this.gitCheckout(workspace, glProject.default_branch);

      await this.updateStatus(ctx, AgentStatus.IDLE);

    } catch (err) {
      this.logger.error(`fixIssue failed: ${err.message}`, err.stack);

      // Mark task as FAILED in DB (prevents orphaned RUNNING tasks)
      if (agentTask) {
        try {
          await this.prisma.agentTask.update({
            where: { id: agentTask.id },
            data: { status: AgentTaskStatus.FAILED, completedAt: new Date() },
          });
        } catch { /* best effort */ }
      }

      // Reset issue status so it can be retried
      try {
        await this.issuesService.update(issueId, { status: IssueStatus.OPEN });
      } catch { /* best effort */ }

      await this.sendAgentMessage(ctx, `❌ Fix failed: ${err.message}`);
      await this.updateStatus(ctx, AgentStatus.ERROR);
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
      '4. If the project uses npm: run "npm install" after adding dependencies to package.json',
      '5. Verify your changes are consistent with the existing codebase',
      '',
      'Rules:',
      '- ALWAYS use relative paths (e.g., "src/app.ts", "packages/backend/package.json")',
      '- Follow existing code patterns and conventions',
      '- Add error handling where appropriate',
      '- Do NOT create test files unless the task specifically asks for tests',
      '- Do NOT modify unrelated files',
      '- If asked to fix security vulnerabilities, use "npm audit fix" or update package versions',
      '- When done, respond with a brief summary of what you changed',
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
    const parts: string[] = [
      `Fix the following issue based on ${source} feedback:`,
      '',
      `## ${issue.title}`,
      '',
      issue.description || 'No description provided.',
      '',
      `## Feedback to address:`,
      feedback,
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
