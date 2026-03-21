import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ChatService } from '../chat/chat.service';
import { ChatGateway } from '../chat/chat.gateway';
import { SystemSettingsService } from '../settings/system-settings.service';
import { GitlabService } from '../gitlab/gitlab.service';
import { InterviewerAgent } from './interviewer/interviewer.agent';
import { DevopsAgent } from './devops/devops.agent';
import { ArchitectAgent } from './architect/architect.agent';
import { IssueCompilerAgent } from './issue-compiler/issue-compiler.agent';
import { CoderAgent } from './coder/coder.agent';
import { CodeReviewerAgent } from './code-reviewer/code-reviewer.agent';
import { FunctionalTesterAgent } from './functional-tester/functional-tester.agent';
import { UiTesterAgent } from './ui-tester/ui-tester.agent';
import { PenTesterAgent } from './pen-tester/pen-tester.agent';
import { DocumenterAgent } from './documenter/documenter.agent';
import { getSessionWorktreePath } from './agent-base';
import {
  AgentRole,
  AgentStatus,
  AgentTaskType,
  AgentTaskStatus,
  ChatSessionType,
  IssueStatus,
} from '@prisma/client';

const execFileAsync = promisify(execFile);

@Injectable()
export class PipelineFlowService {
  private readonly logger = new Logger(PipelineFlowService.name);

  /**
   * In-memory lock to prevent race conditions when starting agents.
   */
  private readonly startingAgents = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly chatService: ChatService,
    private readonly chatGateway: ChatGateway,
    private readonly settings: SystemSettingsService,
    private readonly gitlabService: GitlabService,
    private readonly interviewer: InterviewerAgent,
    private readonly devops: DevopsAgent,
    private readonly architect: ArchitectAgent,
    private readonly issueCompiler: IssueCompilerAgent,
    private readonly coder: CoderAgent,
    private readonly codeReviewer: CodeReviewerAgent,
    private readonly functionalTester: FunctionalTesterAgent,
    private readonly uiTester: UiTesterAgent,
    private readonly penTester: PenTesterAgent,
    private readonly documenter: DocumenterAgent,
  ) {}

  // ─── Guard Helpers ──────────────────────────────────────────

  acquireStartLock(projectId: string, role: AgentRole): boolean {
    const key = `${projectId}:${role}`;
    if (this.startingAgents.has(key)) {
      this.logger.warn(
        `${role} start already in progress for project ${projectId} — skipping duplicate`,
      );
      return false;
    }
    this.startingAgents.add(key);
    return true;
  }

  releaseStartLock(projectId: string, role: AgentRole): void {
    this.startingAgents.delete(`${projectId}:${role}`);
  }

  async getSessionFilter(
    chatSessionId: string,
  ): Promise<{ chatSessionId?: string }> {
    if (!chatSessionId) return {};
    const session = await this.prisma.chatSession.findUnique({
      where: { id: chatSessionId },
      select: { type: true },
    });
    if (session?.type === ChatSessionType.DEV_SESSION) {
      return { chatSessionId };
    }
    return {};
  }

  async hasActiveAgent(projectId: string, role: AgentRole): Promise<boolean> {
    const existing = await this.prisma.agentInstance.findFirst({
      where: {
        projectId,
        role,
        status: { in: [AgentStatus.WORKING, AgentStatus.WAITING] },
      },
    });

    if (existing) {
      this.logger.warn(
        `${role} already active for project ${projectId} (${existing.id}) — skipping duplicate`,
      );
      return true;
    }

    const runningTask = await this.prisma.agentTask.findFirst({
      where: {
        agent: { projectId, role },
        status: AgentTaskStatus.RUNNING,
      },
    });

    if (runningTask) {
      this.logger.warn(
        `${role} has running task for project ${projectId} (${runningTask.id}) — skipping duplicate`,
      );
      return true;
    }

    return false;
  }

  async getProjectAgentStatus(projectId: string) {
    return this.prisma.agentInstance.findMany({
      where: { projectId },
      include: {
        tasks: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });
  }

  // ─── Interview ──────────────────────────────────────────────

  async startInterview(projectId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
    });
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    const config = this.settings.getAgentRoleConfig('INTERVIEWER');

    const agentInstance = await this.prisma.agentInstance.create({
      data: {
        projectId,
        role: AgentRole.INTERVIEWER,
        provider: config.provider as any,
        model: config.model,
        status: AgentStatus.IDLE,
      },
    });

    const agentTask = await this.prisma.agentTask.create({
      data: {
        agentId: agentInstance.id,
        type: AgentTaskType.INTERVIEW,
        status: AgentTaskStatus.RUNNING,
        startedAt: new Date(),
      },
    });

    const chatSession = await this.chatService.createSession({
      projectId,
      title: 'Project Interview',
    });

    const ctx = {
      projectId,
      agentInstanceId: agentInstance.id,
      agentTaskId: agentTask.id,
      chatSessionId: chatSession.id,
    };

    this.interviewer.startInterview(ctx, project.name).catch((err) => {
      this.logger.error(`Failed to start interview: ${err.message}`);
    });

    return {
      agentInstanceId: agentInstance.id,
      agentTaskId: agentTask.id,
      chatSessionId: chatSession.id,
    };
  }

  async continueInterview(ctx: {
    projectId: string;
    agentInstanceId: string;
    agentTaskId: string;
    chatSessionId: string;
  }) {
    this.interviewer.continueInterview(ctx).catch((err) => {
      this.logger.error(`Interviewer error: ${err.message}`);
    });
  }

  async continueFeatureInterview(ctx: {
    projectId: string;
    agentInstanceId: string;
    agentTaskId: string;
    chatSessionId: string;
  }) {
    this.interviewer.continueFeatureInterview(ctx).catch((err) => {
      this.logger.error(`Feature interviewer error: ${err.message}`);
    });
  }

  // ─── DevOps ─────────────────────────────────────────────────

  async startDevopsSetup(projectId: string, chatSessionId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
    });
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    const config = this.settings.getAgentRoleConfig('DEVOPS');

    const agentInstance = await this.prisma.agentInstance.create({
      data: {
        projectId,
        role: AgentRole.DEVOPS,
        provider: config.provider as any,
        model: config.model,
        status: AgentStatus.IDLE,
      },
    });

    const agentTask = await this.prisma.agentTask.create({
      data: {
        agentId: agentInstance.id,
        type: AgentTaskType.DEPLOY,
        status: AgentTaskStatus.RUNNING,
        startedAt: new Date(),
      },
    });

    const ctx = {
      projectId,
      agentInstanceId: agentInstance.id,
      agentTaskId: agentTask.id,
      chatSessionId,
    };

    this.devops.runSetup(ctx).catch((err) => {
      this.logger.error(`DevOps setup error: ${err.message}`);
    });

    return {
      agentInstanceId: agentInstance.id,
      agentTaskId: agentTask.id,
      chatSessionId,
    };
  }

  async startInfraCommand(
    projectId: string,
    chatSessionId: string,
    userMessage: string,
  ) {
    if (await this.hasActiveAgent(projectId, AgentRole.DEVOPS)) {
      this.logger.debug(
        `DevOps agent already active for project ${projectId} — queuing message`,
      );
      return;
    }

    const config = this.settings.getAgentRoleConfig('DEVOPS');

    const agentInstance = await this.prisma.agentInstance.create({
      data: {
        projectId,
        role: AgentRole.DEVOPS,
        provider: config.provider as any,
        model: config.model,
        status: AgentStatus.IDLE,
      },
    });

    const agentTask = await this.prisma.agentTask.create({
      data: {
        agentId: agentInstance.id,
        type: AgentTaskType.INFRA_COMMAND,
        status: AgentTaskStatus.RUNNING,
        startedAt: new Date(),
      },
    });

    const ctx = {
      projectId,
      agentInstanceId: agentInstance.id,
      agentTaskId: agentTask.id,
      chatSessionId,
    };

    this.devops.handleInfraCommand(ctx, userMessage).catch((err) => {
      this.logger.error(`Infra command error: ${err.message}`);
    });
  }

  // ─── Feature Interview ──────────────────────────────────────

  async startFeatureInterview(
    projectId: string,
    chatSessionId: string,
    sessionTitle: string,
  ) {
    const config = this.settings.getAgentRoleConfig('INTERVIEWER');

    const agentInstance = await this.prisma.agentInstance.create({
      data: {
        projectId,
        role: AgentRole.INTERVIEWER,
        provider: config.provider as any,
        model: config.model,
        status: AgentStatus.IDLE,
      },
    });

    const agentTask = await this.prisma.agentTask.create({
      data: {
        agentId: agentInstance.id,
        type: AgentTaskType.FEATURE_INTERVIEW,
        status: AgentTaskStatus.RUNNING,
        startedAt: new Date(),
      },
    });

    const ctx = {
      projectId,
      agentInstanceId: agentInstance.id,
      agentTaskId: agentTask.id,
      chatSessionId,
    };

    this.interviewer.startFeatureInterview(ctx, sessionTitle).catch((err) => {
      this.logger.error(`Feature interview error: ${err.message}`);
    });

    return {
      agentInstanceId: agentInstance.id,
      agentTaskId: agentTask.id,
      chatSessionId,
    };
  }

  // ─── Architect ──────────────────────────────────────────────

  async startArchitectDesign(projectId: string, chatSessionId: string) {
    const config = this.settings.getAgentRoleConfig('ARCHITECT');

    const agentInstance = await this.prisma.agentInstance.create({
      data: {
        projectId,
        role: AgentRole.ARCHITECT,
        provider: config.provider as any,
        model: config.model,
        status: AgentStatus.IDLE,
      },
    });

    const agentTask = await this.prisma.agentTask.create({
      data: {
        agentId: agentInstance.id,
        type: AgentTaskType.DESIGN_ARCHITECTURE,
        status: AgentTaskStatus.RUNNING,
        startedAt: new Date(),
      },
    });

    const ctx = {
      projectId,
      agentInstanceId: agentInstance.id,
      agentTaskId: agentTask.id,
      chatSessionId,
    };

    this.architect.designArchitecture(ctx).catch((err) => {
      this.logger.error(`Architect (Phase A) error: ${err.message}`);
    });
  }

  async startArchitectGrounding(projectId: string, chatSessionId: string) {
    const config = this.settings.getAgentRoleConfig('ARCHITECT');

    const agentInstance = await this.prisma.agentInstance.create({
      data: {
        projectId,
        role: AgentRole.ARCHITECT,
        provider: config.provider as any,
        model: config.model,
        status: AgentStatus.IDLE,
      },
    });

    const agentTask = await this.prisma.agentTask.create({
      data: {
        agentId: agentInstance.id,
        type: AgentTaskType.ANALYZE_ISSUES,
        status: AgentTaskStatus.RUNNING,
        startedAt: new Date(),
      },
    });

    const ctx = {
      projectId,
      agentInstanceId: agentInstance.id,
      agentTaskId: agentTask.id,
      chatSessionId,
    };

    this.architect.groundIssues(ctx).catch((err) => {
      this.logger.error(`Architect (Phase B) error: ${err.message}`);
    });
  }

  // ─── Issue Compiler ─────────────────────────────────────────

  async startIssueCompilation(projectId: string, chatSessionId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
    });
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    const config = this.settings.getAgentRoleConfig('ISSUE_COMPILER');

    const agentInstance = await this.prisma.agentInstance.create({
      data: {
        projectId,
        role: AgentRole.ISSUE_COMPILER,
        provider: config.provider as any,
        model: config.model,
        status: AgentStatus.IDLE,
      },
    });

    const agentTask = await this.prisma.agentTask.create({
      data: {
        agentId: agentInstance.id,
        type: AgentTaskType.CREATE_ISSUES,
        status: AgentTaskStatus.RUNNING,
        startedAt: new Date(),
      },
    });

    const ctx = {
      projectId,
      agentInstanceId: agentInstance.id,
      agentTaskId: agentTask.id,
      chatSessionId,
    };

    this.issueCompiler.runCompilation(ctx).catch((err) => {
      this.logger.error(`Issue Compiler error: ${err.message}`);
    });

    return {
      agentInstanceId: agentInstance.id,
      agentTaskId: agentTask.id,
      chatSessionId,
    };
  }

  // ─── Coder ──────────────────────────────────────────────────

  async startCoding(projectId: string, chatSessionId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
    });
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    const config = this.settings.getAgentRoleConfig('CODER');

    const agentInstance = await this.prisma.agentInstance.create({
      data: {
        projectId,
        role: AgentRole.CODER,
        provider: config.provider as any,
        model: config.model,
        status: AgentStatus.IDLE,
      },
    });

    const agentTask = await this.prisma.agentTask.create({
      data: {
        agentId: agentInstance.id,
        type: AgentTaskType.WRITE_CODE,
        status: AgentTaskStatus.RUNNING,
        startedAt: new Date(),
      },
    });

    const ctx = {
      projectId,
      agentInstanceId: agentInstance.id,
      agentTaskId: agentTask.id,
      chatSessionId,
    };

    this.coder.runMilestoneCoding(ctx).catch((err) => {
      this.logger.error(`Coder Agent error: ${err.message}`);
    });

    return {
      agentInstanceId: agentInstance.id,
      agentTaskId: agentTask.id,
      chatSessionId,
    };
  }

  // ─── Code Review ────────────────────────────────────────────

  async startCodeReview(
    projectId: string,
    chatSessionId: string,
    issueId: string,
    mrIid: number,
    gitlabProjectId: number,
  ) {
    const config = this.settings.getAgentRoleConfig('CODE_REVIEWER');

    const agentInstance = await this.prisma.agentInstance.create({
      data: {
        projectId,
        role: AgentRole.CODE_REVIEWER,
        provider: config.provider as any,
        model: config.model,
        status: AgentStatus.IDLE,
      },
    });

    const agentTask = await this.prisma.agentTask.create({
      data: {
        agentId: agentInstance.id,
        issueId,
        type: AgentTaskType.REVIEW_CODE,
        status: AgentTaskStatus.RUNNING,
        startedAt: new Date(),
        gitlabMrIid: mrIid,
      },
    });

    const ctx = {
      projectId,
      agentInstanceId: agentInstance.id,
      agentTaskId: agentTask.id,
      chatSessionId,
    };

    this.codeReviewer
      .reviewIssue(ctx, issueId, mrIid, gitlabProjectId)
      .catch((err) => {
        this.logger.error(`Code Reviewer error: ${err.message}`);
      });
  }

  // ─── Functional Tester ──────────────────────────────────────

  async startFunctionalTest(
    projectId: string,
    chatSessionId: string,
    issueId: string,
    mrIid: number,
    gitlabProjectId: number,
  ) {
    const config = this.settings.getAgentRoleConfig('FUNCTIONAL_TESTER');

    const agentInstance = await this.prisma.agentInstance.create({
      data: {
        projectId,
        role: AgentRole.FUNCTIONAL_TESTER,
        provider: config.provider as any,
        model: config.model,
        status: AgentStatus.IDLE,
      },
    });

    const agentTask = await this.prisma.agentTask.create({
      data: {
        agentId: agentInstance.id,
        issueId,
        type: AgentTaskType.TEST_FUNCTIONAL,
        status: AgentTaskStatus.RUNNING,
        startedAt: new Date(),
        gitlabMrIid: mrIid,
      },
    });

    const ctx = {
      projectId,
      agentInstanceId: agentInstance.id,
      agentTaskId: agentTask.id,
      chatSessionId,
    };

    this.functionalTester
      .testIssue(ctx, issueId, mrIid, gitlabProjectId)
      .catch((err) => {
        this.logger.error(`Functional Tester error: ${err.message}`);
      });
  }

  // ─── UI Tester ──────────────────────────────────────────────

  async startUiTest(
    projectId: string,
    chatSessionId: string,
    issueId: string,
    mrIid: number,
    gitlabProjectId: number,
  ) {
    const config = this.settings.getAgentRoleConfig('UI_TESTER');

    const agentInstance = await this.prisma.agentInstance.create({
      data: {
        projectId,
        role: AgentRole.UI_TESTER,
        provider: config.provider as any,
        model: config.model,
        status: AgentStatus.IDLE,
      },
    });

    const agentTask = await this.prisma.agentTask.create({
      data: {
        agentId: agentInstance.id,
        issueId,
        type: AgentTaskType.TEST_UI,
        status: AgentTaskStatus.RUNNING,
        startedAt: new Date(),
        gitlabMrIid: mrIid,
      },
    });

    const ctx = {
      projectId,
      agentInstanceId: agentInstance.id,
      agentTaskId: agentTask.id,
      chatSessionId,
    };

    this.uiTester
      .testIssue(ctx, issueId, mrIid, gitlabProjectId)
      .catch((err) => {
        this.logger.error(`UI Tester error: ${err.message}`);
      });
  }

  // ─── Pen Tester ─────────────────────────────────────────────

  async startPenTest(
    projectId: string,
    chatSessionId: string,
    issueId: string,
    mrIid: number,
    gitlabProjectId: number,
  ) {
    const config = this.settings.getAgentRoleConfig('PEN_TESTER');

    const agentInstance = await this.prisma.agentInstance.create({
      data: {
        projectId,
        role: AgentRole.PEN_TESTER,
        provider: config.provider as any,
        model: config.model,
        status: AgentStatus.IDLE,
      },
    });

    const agentTask = await this.prisma.agentTask.create({
      data: {
        agentId: agentInstance.id,
        issueId,
        type: AgentTaskType.TEST_SECURITY,
        status: AgentTaskStatus.RUNNING,
        startedAt: new Date(),
        gitlabMrIid: mrIid,
      },
    });

    const ctx = {
      projectId,
      agentInstanceId: agentInstance.id,
      agentTaskId: agentTask.id,
      chatSessionId,
    };

    this.penTester
      .testIssue(ctx, issueId, mrIid, gitlabProjectId)
      .catch((err) => {
        this.logger.error(`Pen Tester error: ${err.message}`);
      });
  }

  // ─── Documenter ─────────────────────────────────────────────

  async startDocumenter(
    projectId: string,
    chatSessionId: string,
    issueId: string,
    mrIid: number,
    gitlabProjectId: number,
  ) {
    const config = this.settings.getAgentRoleConfig('DOCUMENTER');

    const agentInstance = await this.prisma.agentInstance.create({
      data: {
        projectId,
        role: AgentRole.DOCUMENTER,
        provider: config.provider as any,
        model: config.model,
        status: AgentStatus.IDLE,
      },
    });

    const agentTask = await this.prisma.agentTask.create({
      data: {
        agentId: agentInstance.id,
        issueId,
        type: AgentTaskType.WRITE_DOCS,
        status: AgentTaskStatus.RUNNING,
        startedAt: new Date(),
        gitlabMrIid: mrIid,
      },
    });

    const ctx = {
      projectId,
      agentInstanceId: agentInstance.id,
      agentTaskId: agentTask.id,
      chatSessionId,
    };

    this.documenter
      .documentIssue(ctx, issueId, mrIid, gitlabProjectId)
      .catch((err) => {
        this.logger.error(`Documenter error: ${err.message}`);
      });
  }

  // ─── Issue Completion (Merge + Next) ────────────────────────

  async completeIssue(
    projectId: string,
    chatSessionId: string,
    issueId: string,
    mrIid: number,
    gitlabProjectId: number,
  ): Promise<void> {
    const pipelineConfig = this.settings.getPipelineConfig();
    const mergeConfig = pipelineConfig.merge ?? {
      autoMerge: true,
      method: 'merge' as const,
      removeSourceBranch: true,
      requireApproval: false,
      closeIssueOnMerge: true,
    };

    this.logger.log(
      `Documentation complete for issue ${issueId} — merge config: ${JSON.stringify(mergeConfig)}`,
    );

    if (mergeConfig.requireApproval) {
      this.logger.log(
        `Merge requires approval — waiting for user action on MR !${mrIid}`,
      );
      this.chatGateway.emitToSession(chatSessionId, 'chatSuggestions', {
        chatSessionId,
        suggestions: ['✅ Merge', '⚠️ Review first', '❌ Reject MR'],
      });
      await this.prisma.issue.update({
        where: { id: issueId },
        data: { status: IssueStatus.NEEDS_REVIEW },
      });
      return;
    }

    if (!mergeConfig.autoMerge) {
      this.logger.log(`Auto-merge disabled — MR !${mrIid} stays open`);
      return;
    }

    const MAX_MERGE_RETRIES = 3;
    const RETRY_DELAY_MS = 5_000;
    let merged = false;

    for (let attempt = 1; attempt <= MAX_MERGE_RETRIES; attempt++) {
      try {
        await this.gitlabService.acceptMergeRequest(gitlabProjectId, mrIid, {
          squash: mergeConfig.method === 'squash',
          removeSourceBranch: mergeConfig.removeSourceBranch,
        });
        this.logger.log(
          `MR !${mrIid} merged (method: ${mergeConfig.method}) for issue ${issueId}`,
        );
        merged = true;
        break;
      } catch (mergeErr) {
        const msg = mergeErr.message ?? String(mergeErr);
        const isConflict =
          /conflict|cannot be merged|merge_request_not_mergeable/i.test(msg);

        if (isConflict) {
          this.logger.error(
            `MR !${mrIid} has merge conflicts — needs manual resolution: ${msg}`,
          );
          await this.prisma.issue.update({
            where: { id: issueId },
            data: { status: IssueStatus.NEEDS_REVIEW },
          });
          break;
        }

        if (attempt < MAX_MERGE_RETRIES) {
          this.logger.warn(
            `Merge attempt ${attempt}/${MAX_MERGE_RETRIES} failed for MR !${mrIid}: ${msg} — retrying in ${RETRY_DELAY_MS / 1000}s`,
          );
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        } else {
          this.logger.error(
            `All ${MAX_MERGE_RETRIES} merge attempts failed for MR !${mrIid}: ${msg}`,
          );
          await this.prisma.issue.update({
            where: { id: issueId },
            data: { status: IssueStatus.NEEDS_REVIEW },
          });
        }
      }
    }

    if (merged) {
      await this.prisma.issue.update({
        where: { id: issueId },
        data: { status: IssueStatus.DONE },
      });

      await this.prisma.issue.updateMany({
        where: {
          parentId: issueId,
          status: { notIn: [IssueStatus.DONE, IssueStatus.CLOSED] },
        },
        data: { status: IssueStatus.DONE },
      });

      if (mergeConfig.closeIssueOnMerge) {
        const issue = await this.prisma.issue.findUnique({
          where: { id: issueId },
          select: { gitlabIid: true },
        });
        if (issue?.gitlabIid) {
          try {
            await this.gitlabService.closeIssue(
              gitlabProjectId,
              issue.gitlabIid,
            );
            this.logger.log(
              `Closed GitLab issue #${issue.gitlabIid} after merge`,
            );
          } catch (err) {
            this.logger.warn(`Failed to close GitLab issue: ${err.message}`);
          }
        }
      }

      await this.pullLatestInWorkspace(projectId, chatSessionId);

      const chatSessionFilter = await this.getSessionFilter(chatSessionId);
      const nextOpen = await this.prisma.issue.findFirst({
        where: {
          projectId,
          status: IssueStatus.OPEN,
          parentId: null,
          ...chatSessionFilter,
        },
      });
      if (nextOpen) {
        this.logger.log(
          `Issue ${issueId} merged — ${nextOpen.id} is next in queue, triggering Coder`,
        );
        try {
          await this.startCoding(projectId, chatSessionId);
        } catch (err) {
          this.logger.error(
            `Failed to start Coder for next issue: ${err.message}`,
          );
        }
      } else {
        this.logger.log(
          `Issue ${issueId} merged — no more open issues, pipeline complete!`,
        );
        this.chatGateway.emitToSession(chatSessionId, 'chatSuggestions', {
          chatSessionId,
          suggestions: ['🎉 All issues done!', '📋 Show summary'],
        });
      }
    }
  }

  async pullLatestInWorkspace(
    projectId: string,
    chatSessionId: string,
  ): Promise<void> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
    });
    if (!project) return;

    const sessionInfo = await this.prisma.chatSession.findUnique({
      where: { id: chatSessionId },
      select: { type: true, branch: true },
    });
    const isDevSession = sessionInfo?.type === ChatSessionType.DEV_SESSION;

    let workspace: string;
    let baseBranch: string;

    if (isDevSession && sessionInfo.branch) {
      workspace = getSessionWorktreePath(
        this.settings.devopsWorkspacePath,
        project.slug,
        sessionInfo.branch,
      );
      baseBranch = sessionInfo.branch;
    } else {
      workspace = path.resolve(
        this.settings.devopsWorkspacePath,
        project.slug,
      );
      baseBranch = project.workBranch || 'main';
    }

    try {
      await execFileAsync('git', ['checkout', baseBranch], {
        cwd: workspace,
        timeout: 10_000,
      });
      await execFileAsync('git', ['pull', '--ff-only'], {
        cwd: workspace,
        timeout: 30_000,
      });
      this.logger.log(`Pulled latest ${baseBranch} in workspace ${workspace}`);
    } catch (pullErr) {
      this.logger.warn(
        `Failed to pull ${baseBranch} in workspace: ${pullErr.message}`,
      );
    }
  }
}
