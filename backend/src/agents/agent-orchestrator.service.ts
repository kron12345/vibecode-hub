import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import { ChatService } from '../chat/chat.service';
import { SystemSettingsService } from '../settings/system-settings.service';
import { GitlabService } from '../gitlab/gitlab.service';
import { InterviewerAgent } from './interviewer/interviewer.agent';
import { DevopsAgent } from './devops/devops.agent';
import { IssueCompilerAgent } from './issue-compiler/issue-compiler.agent';
import { CoderAgent } from './coder/coder.agent';
import { CodeReviewerAgent } from './code-reviewer/code-reviewer.agent';
import { FunctionalTesterAgent } from './functional-tester/functional-tester.agent';
import { UiTesterAgent } from './ui-tester/ui-tester.agent';
import { PenTesterAgent } from './pen-tester/pen-tester.agent';
import { DocumenterAgent } from './documenter/documenter.agent';
import {
  AgentRole,
  AgentStatus,
  AgentTaskType,
  AgentTaskStatus,
  IssueStatus,
  ProjectStatus,
} from '@prisma/client';

@Injectable()
export class AgentOrchestratorService {
  private readonly logger = new Logger(AgentOrchestratorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly chatService: ChatService,
    private readonly settings: SystemSettingsService,
    private readonly gitlabService: GitlabService,
    private readonly interviewer: InterviewerAgent,
    private readonly devops: DevopsAgent,
    private readonly issueCompiler: IssueCompilerAgent,
    private readonly coder: CoderAgent,
    private readonly codeReviewer: CodeReviewerAgent,
    private readonly functionalTester: FunctionalTesterAgent,
    private readonly uiTester: UiTesterAgent,
    private readonly penTester: PenTesterAgent,
    private readonly documenter: DocumenterAgent,
  ) {}

  /**
   * Guard: Check if there's already an active agent of the given role for a project.
   * Returns true if an agent is already running (caller should skip).
   */
  private async hasActiveAgent(projectId: string, role: AgentRole): Promise<boolean> {
    const existing = await this.prisma.agentInstance.findFirst({
      where: {
        projectId,
        role,
        status: { in: [AgentStatus.WORKING, AgentStatus.WAITING] },
      },
    });

    if (existing) {
      this.logger.warn(`${role} already active for project ${projectId} (${existing.id}) — skipping duplicate`);
      return true;
    }

    // Also check for running tasks of this role (agent might be IDLE but task still RUNNING)
    const runningTask = await this.prisma.agentTask.findFirst({
      where: {
        agent: { projectId, role },
        status: AgentTaskStatus.RUNNING,
      },
    });

    if (runningTask) {
      this.logger.warn(`${role} has running task for project ${projectId} (${runningTask.id}) — skipping duplicate`);
      return true;
    }

    return false;
  }

  /**
   * Start an interview for a project.
   * Creates AgentInstance, AgentTask, ChatSession, and kicks off the first question.
   */
  async startInterview(projectId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
    });
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    // Get interviewer config for provider/model
    const config = this.settings.getAgentRoleConfig('INTERVIEWER');

    // Create agent instance
    const agentInstance = await this.prisma.agentInstance.create({
      data: {
        projectId,
        role: AgentRole.INTERVIEWER,
        provider: config.provider as any,
        model: config.model,
        status: AgentStatus.IDLE,
      },
    });

    // Create agent task
    const agentTask = await this.prisma.agentTask.create({
      data: {
        agentId: agentInstance.id,
        type: AgentTaskType.INTERVIEW,
        status: AgentTaskStatus.RUNNING,
        startedAt: new Date(),
      },
    });

    // Create chat session for the interview
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

    // Start the interview asynchronously (don't block the response)
    this.interviewer.startInterview(ctx, project.name).catch((err) => {
      this.logger.error(`Failed to start interview: ${err.message}`);
    });

    return {
      agentInstanceId: agentInstance.id,
      agentTaskId: agentTask.id,
      chatSessionId: chatSession.id,
    };
  }

  /**
   * Handle user messages — if there's an active interview, route to the interviewer.
   * Triggered by EventEmitter from ChatGateway.
   */
  @OnEvent('chat.userMessage')
  async handleUserMessage(payload: {
    chatSessionId: string;
    content: string;
  }) {
    const { chatSessionId } = payload;

    // Find an active interview task for this chat session
    const chatSession = await this.prisma.chatSession.findUnique({
      where: { id: chatSessionId },
      select: { projectId: true },
    });

    if (!chatSession) return;

    // Look for an active interviewer agent with a running task
    const activeAgent = await this.prisma.agentInstance.findFirst({
      where: {
        projectId: chatSession.projectId,
        role: AgentRole.INTERVIEWER,
        status: { in: [AgentStatus.WAITING, AgentStatus.WORKING] },
      },
      include: {
        tasks: {
          where: { status: AgentTaskStatus.RUNNING },
          take: 1,
        },
      },
    });

    if (!activeAgent || activeAgent.tasks.length === 0) return;

    const ctx = {
      projectId: chatSession.projectId,
      agentInstanceId: activeAgent.id,
      agentTaskId: activeAgent.tasks[0].id,
      chatSessionId,
    };

    this.logger.debug(
      `Routing user message to interviewer for project ${chatSession.projectId}`,
    );

    // Continue the interview asynchronously
    this.interviewer.continueInterview(ctx).catch((err) => {
      this.logger.error(`Interviewer error: ${err.message}`);
    });
  }

  /** Get agent status for a project */
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

  // ─── DevOps Agent ──────────────────────────────────────────

  /**
   * Handle interview completion — automatically start DevOps setup.
   * Reuses the same chat session for seamless flow.
   */
  @OnEvent('agent.interviewComplete')
  async handleInterviewComplete(payload: {
    projectId: string;
    chatSessionId: string;
  }) {
    const { projectId, chatSessionId } = payload;

    if (await this.hasActiveAgent(projectId, AgentRole.DEVOPS)) return;

    this.logger.log(`Interview complete for project ${projectId} — starting DevOps setup`);

    try {
      await this.startDevopsSetup(projectId, chatSessionId);
    } catch (err) {
      this.logger.error(`Failed to start DevOps setup: ${err.message}`);
    }
  }

  /**
   * Start the DevOps agent for project setup.
   * Creates AgentInstance + AgentTask, reuses the given chat session.
   */
  async startDevopsSetup(projectId: string, chatSessionId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
    });
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    // Get DevOps config for provider/model
    const config = this.settings.getAgentRoleConfig('DEVOPS');

    // Create agent instance
    const agentInstance = await this.prisma.agentInstance.create({
      data: {
        projectId,
        role: AgentRole.DEVOPS,
        provider: config.provider as any,
        model: config.model,
        status: AgentStatus.IDLE,
      },
    });

    // Create agent task
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

    // Start setup asynchronously (don't block)
    this.devops.runSetup(ctx).catch((err) => {
      this.logger.error(`DevOps setup error: ${err.message}`);
    });

    return {
      agentInstanceId: agentInstance.id,
      agentTaskId: agentTask.id,
      chatSessionId,
    };
  }

  // ─── Issue Compiler Agent ───────────────────────────────────

  /**
   * Handle DevOps completion — automatically start Issue Compiler.
   * Reuses the same chat session for seamless flow.
   */
  @OnEvent('agent.devopsComplete')
  async handleDevopsComplete(payload: {
    projectId: string;
    chatSessionId: string;
  }) {
    const { projectId, chatSessionId } = payload;

    if (await this.hasActiveAgent(projectId, AgentRole.ISSUE_COMPILER)) return;

    this.logger.log(`DevOps complete for project ${projectId} — starting Issue Compiler`);

    try {
      await this.startIssueCompilation(projectId, chatSessionId);
    } catch (err) {
      this.logger.error(`Failed to start Issue Compiler: ${err.message}`);
    }
  }

  /**
   * Start the Issue Compiler agent.
   * Creates AgentInstance + AgentTask, reuses the given chat session.
   */
  async startIssueCompilation(projectId: string, chatSessionId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
    });
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    // Get Issue Compiler config for provider/model
    const config = this.settings.getAgentRoleConfig('ISSUE_COMPILER');

    // Create agent instance
    const agentInstance = await this.prisma.agentInstance.create({
      data: {
        projectId,
        role: AgentRole.ISSUE_COMPILER,
        provider: config.provider as any,
        model: config.model,
        status: AgentStatus.IDLE,
      },
    });

    // Create agent task
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

    // Start compilation asynchronously (don't block)
    this.issueCompiler.runCompilation(ctx).catch((err) => {
      this.logger.error(`Issue Compiler error: ${err.message}`);
    });

    return {
      agentInstanceId: agentInstance.id,
      agentTaskId: agentTask.id,
      chatSessionId,
    };
  }

  // ─── Coder Agent ──────────────────────────────────────────

  /**
   * Handle issue compilation completion — automatically start Coder Agent.
   */
  @OnEvent('agent.issueCompilerComplete')
  async handleIssueCompilerComplete(payload: {
    projectId: string;
    chatSessionId: string;
  }) {
    const { projectId, chatSessionId } = payload;

    if (await this.hasActiveAgent(projectId, AgentRole.CODER)) return;

    this.logger.log(`Issue compilation complete for project ${projectId} — starting Coder Agent`);

    try {
      await this.startCoding(projectId, chatSessionId);
    } catch (err) {
      this.logger.error(`Failed to start Coder Agent: ${err.message}`);
    }
  }

  /**
   * Start the Coder agent for milestone coding.
   */
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

  // ─── Code Reviewer Agent ──────────────────────────────────

  /**
   * Handle coding completion — automatically start Code Review.
   */
  @OnEvent('agent.codingComplete')
  async handleCodingComplete(payload: {
    projectId: string;
    chatSessionId: string;
    issueId: string;
    gitlabIid: number;
    mrIid?: number;
    gitlabProjectId: number;
    branch: string;
  }) {
    const { projectId, chatSessionId, issueId, mrIid, gitlabProjectId } = payload;

    if (!mrIid) {
      this.logger.warn(`No MR for issue ${issueId} — skipping code review`);
      return;
    }

    // Check for existing review task on this specific issue
    const existingReview = await this.prisma.agentTask.findFirst({
      where: {
        issueId,
        type: AgentTaskType.REVIEW_CODE,
        status: AgentTaskStatus.RUNNING,
      },
    });
    if (existingReview) {
      this.logger.warn(`Code review already running for issue ${issueId} — skipping duplicate`);
      return;
    }

    this.logger.log(`Coding complete for issue ${issueId} — starting Code Review`);

    try {
      await this.startCodeReview(projectId, chatSessionId, issueId, mrIid, gitlabProjectId);
    } catch (err) {
      this.logger.error(`Failed to start Code Review: ${err.message}`);
    }
  }

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

    this.codeReviewer.reviewIssue(ctx, issueId, mrIid, gitlabProjectId).catch((err) => {
      this.logger.error(`Code Reviewer error: ${err.message}`);
    });
  }

  /**
   * Handle review changes requested — re-trigger Coder with review feedback.
   */
  @OnEvent('agent.reviewChangesRequested')
  async handleReviewChangesRequested(payload: {
    projectId: string;
    chatSessionId: string;
    issueId: string;
    feedback: string;
  }) {
    const { projectId, chatSessionId, issueId, feedback } = payload;
    this.logger.log(`Review changes requested for issue ${issueId} — re-triggering Coder`);

    try {
      // Find or create coder agent instance
      let coderInstance = await this.prisma.agentInstance.findFirst({
        where: { projectId, role: AgentRole.CODER, status: { in: [AgentStatus.IDLE, AgentStatus.WORKING] } },
      });

      if (!coderInstance) {
        const config = this.settings.getAgentRoleConfig('CODER');
        coderInstance = await this.prisma.agentInstance.create({
          data: {
            projectId,
            role: AgentRole.CODER,
            provider: config.provider as any,
            model: config.model,
            status: AgentStatus.IDLE,
          },
        });
      }

      const agentTask = await this.prisma.agentTask.create({
        data: {
          agentId: coderInstance.id,
          issueId,
          type: AgentTaskType.FIX_CODE,
          status: AgentTaskStatus.RUNNING,
          startedAt: new Date(),
        },
      });

      const ctx = {
        projectId,
        agentInstanceId: coderInstance.id,
        agentTaskId: agentTask.id,
        chatSessionId,
      };

      this.coder.fixIssue(ctx, issueId, feedback, 'review').catch((err) => {
        this.logger.error(`Coder fix (review) error: ${err.message}`);
      });
    } catch (err) {
      this.logger.error(`handleReviewChangesRequested error: ${err.message}`);
    }
  }

  // ─── Pipeline Feedback Loop ────────────────────────────────

  /**
   * Handle pipeline results — if failed, trigger Coder to fix.
   */
  @OnEvent('gitlab.pipelineResult')
  async handlePipelineResult(payload: {
    projectId: string;
    gitlabProjectId: number;
    pipelineId: number;
    ref: string;
    status: string;
  }) {
    const { projectId, gitlabProjectId, pipelineId, ref, status } = payload;

    if (status !== 'failed') return;

    // Extract issue IID from branch name: feature/{iid}-{slug}
    const match = ref.match(/^feature\/(\d+)-/);
    if (!match) {
      this.logger.debug(`Pipeline failed on non-feature branch: ${ref}`);
      return;
    }

    const gitlabIid = parseInt(match[1], 10);
    this.logger.log(`Pipeline failed for feature branch ${ref} (issue #${gitlabIid})`);

    // Find the local issue
    const issue = await this.prisma.issue.findFirst({
      where: {
        projectId,
        gitlabIid,
      },
    });

    if (!issue) {
      this.logger.warn(`No local issue for GitLab #${gitlabIid} in project ${projectId}`);
      return;
    }

    // Get job logs
    let failureSummary = 'CI/CD pipeline failed.';
    try {
      const jobs = await this.gitlabService.getPipelineJobs(gitlabProjectId, pipelineId);
      const failedJobs = jobs.filter(j => j.status === 'failed').slice(0, 3);

      const logParts: string[] = [];
      for (const job of failedJobs) {
        try {
          const log = await this.gitlabService.getJobLog(gitlabProjectId, job.id);
          logParts.push(`### Job: ${job.name} (${job.stage})\n\`\`\`\n${log.slice(-2000)}\n\`\`\``);
        } catch {
          logParts.push(`### Job: ${job.name} (${job.stage})\n_Could not fetch log_`);
        }
      }

      if (logParts.length > 0) {
        failureSummary = `CI/CD pipeline failed.\n\n${logParts.join('\n\n')}`;
      }
    } catch (err) {
      this.logger.warn(`Could not fetch pipeline job logs: ${err.message}`);
    }

    // Post failure as GitLab comment
    try {
      await this.gitlabService.createIssueNote(
        gitlabProjectId,
        gitlabIid,
        `❌ **CI/CD Pipeline failed** (Pipeline #${pipelineId})\n\n${failureSummary.substring(0, 3000)}`,
      );
    } catch {
      // Non-critical
    }

    // Update issue status
    await this.prisma.issue.update({
      where: { id: issue.id },
      data: { status: IssueStatus.IN_PROGRESS },
    });

    // Sync status label to GitLab
    await this.gitlabService.syncStatusLabel(gitlabProjectId, gitlabIid, 'IN_PROGRESS').catch(() => {});

    // Find chat session for the project
    const chatSession = await this.prisma.chatSession.findFirst({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });

    if (!chatSession) return;

    // Re-trigger Coder
    let coderInstance = await this.prisma.agentInstance.findFirst({
      where: { projectId, role: AgentRole.CODER, status: { in: [AgentStatus.IDLE, AgentStatus.WORKING] } },
    });

    if (!coderInstance) {
      const config = this.settings.getAgentRoleConfig('CODER');
      coderInstance = await this.prisma.agentInstance.create({
        data: {
          projectId,
          role: AgentRole.CODER,
          provider: config.provider as any,
          model: config.model,
          status: AgentStatus.IDLE,
        },
      });
    }

    const agentTask = await this.prisma.agentTask.create({
      data: {
        agentId: coderInstance.id,
        issueId: issue.id,
        type: AgentTaskType.FIX_CODE,
        status: AgentTaskStatus.RUNNING,
        startedAt: new Date(),
      },
    });

    const ctx = {
      projectId,
      agentInstanceId: coderInstance.id,
      agentTaskId: agentTask.id,
      chatSessionId: chatSession.id,
    };

    this.coder.fixIssue(ctx, issue.id, failureSummary, 'pipeline').catch((err) => {
      this.logger.error(`Coder fix (pipeline) error: ${err.message}`);
    });
  }

  // ─── User Feedback Loop ────────────────────────────────────

  /**
   * Handle user comments on issues — re-trigger Coder if needed.
   */
  @OnEvent('gitlab.userComment')
  async handleUserComment(payload: {
    projectId: string;
    issueId: string;
    gitlabIid: number;
    issueStatus: IssueStatus;
    authorName: string;
    content: string;
  }) {
    const { projectId, issueId, issueStatus, authorName, content } = payload;

    // Only react to comments on issues in certain statuses
    const triggerStatuses: IssueStatus[] = [
      IssueStatus.DONE,
      IssueStatus.IN_REVIEW,
      IssueStatus.TESTING,
    ];

    if (!triggerStatuses.includes(issueStatus)) {
      this.logger.debug(`User comment on issue ${issueId} in status ${issueStatus} — ignoring`);
      return;
    }

    this.logger.log(`User ${authorName} commented on issue ${issueId} (status: ${issueStatus}) — re-triggering Coder`);

    // Update issue status → IN_PROGRESS
    const updatedIssue = await this.prisma.issue.update({
      where: { id: issueId },
      data: { status: IssueStatus.IN_PROGRESS },
      include: { project: { select: { gitlabProjectId: true } } },
    });

    // Sync status label to GitLab
    if (updatedIssue.gitlabIid && updatedIssue.project.gitlabProjectId) {
      await this.gitlabService.syncStatusLabel(updatedIssue.project.gitlabProjectId, updatedIssue.gitlabIid, 'IN_PROGRESS').catch(() => {});
    }

    // Find chat session
    const chatSession = await this.prisma.chatSession.findFirst({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });

    if (!chatSession) return;

    // Find or create coder instance
    let coderInstance = await this.prisma.agentInstance.findFirst({
      where: { projectId, role: AgentRole.CODER, status: { in: [AgentStatus.IDLE, AgentStatus.WORKING] } },
    });

    if (!coderInstance) {
      const config = this.settings.getAgentRoleConfig('CODER');
      coderInstance = await this.prisma.agentInstance.create({
        data: {
          projectId,
          role: AgentRole.CODER,
          provider: config.provider as any,
          model: config.model,
          status: AgentStatus.IDLE,
        },
      });
    }

    const agentTask = await this.prisma.agentTask.create({
      data: {
        agentId: coderInstance.id,
        issueId,
        type: AgentTaskType.FIX_CODE,
        status: AgentTaskStatus.RUNNING,
        startedAt: new Date(),
      },
    });

    const ctx = {
      projectId,
      agentInstanceId: coderInstance.id,
      agentTaskId: agentTask.id,
      chatSessionId: chatSession.id,
    };

    this.coder.fixIssue(ctx, issueId, `User feedback from ${authorName}:\n\n${content}`, 'user').catch((err) => {
      this.logger.error(`Coder fix (user feedback) error: ${err.message}`);
    });
  }

  // ─── Review Approved → Functional Tester ─────────────────

  /**
   * Handle review approved — start functional testing.
   */
  @OnEvent('agent.reviewApproved')
  async handleReviewApproved(payload: {
    projectId: string;
    chatSessionId: string;
    issueId: string;
    mrIid: number;
    gitlabProjectId: number;
  }) {
    const { projectId, chatSessionId, issueId, mrIid, gitlabProjectId } = payload;
    this.logger.log(`Review approved for issue ${issueId} — starting Functional Tester`);

    try {
      await this.startFunctionalTest(projectId, chatSessionId, issueId, mrIid, gitlabProjectId);
    } catch (err) {
      this.logger.error(`Failed to start Functional Tester: ${err.message}`);
    }
  }

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

    this.functionalTester.testIssue(ctx, issueId, mrIid, gitlabProjectId).catch((err) => {
      this.logger.error(`Functional Tester error: ${err.message}`);
    });
  }

  // ─── Functional Test Complete → UI Tester ────────────────

  @OnEvent('agent.functionalTestComplete')
  async handleFunctionalTestComplete(payload: {
    projectId: string;
    chatSessionId: string;
    issueId: string;
    mrIid: number;
    gitlabProjectId: number;
    passed: boolean;
    feedback?: string;
  }) {
    const { projectId, chatSessionId, issueId, mrIid, gitlabProjectId, passed, feedback } = payload;

    if (passed) {
      this.logger.log(`Functional test passed for issue ${issueId} — starting UI Tester`);
      try {
        await this.startUiTest(projectId, chatSessionId, issueId, mrIid, gitlabProjectId);
      } catch (err) {
        this.logger.error(`Failed to start UI Tester: ${err.message}`);
      }
    } else {
      this.logger.log(`Functional test failed for issue ${issueId} — re-triggering Coder`);
      await this.retriggerCoder(projectId, chatSessionId, issueId, feedback || 'Functional test failed', 'functional-test');
    }
  }

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

    this.uiTester.testIssue(ctx, issueId, mrIid, gitlabProjectId).catch((err) => {
      this.logger.error(`UI Tester error: ${err.message}`);
    });
  }

  // ─── UI Test Complete → Pen Tester ───────────────────────

  @OnEvent('agent.uiTestComplete')
  async handleUiTestComplete(payload: {
    projectId: string;
    chatSessionId: string;
    issueId: string;
    mrIid: number;
    gitlabProjectId: number;
    passed: boolean;
    feedback?: string;
  }) {
    const { projectId, chatSessionId, issueId, mrIid, gitlabProjectId, passed, feedback } = payload;

    if (passed) {
      this.logger.log(`UI test passed for issue ${issueId} — starting Pen Tester`);
      try {
        await this.startPenTest(projectId, chatSessionId, issueId, mrIid, gitlabProjectId);
      } catch (err) {
        this.logger.error(`Failed to start Pen Tester: ${err.message}`);
      }
    } else {
      this.logger.log(`UI test failed for issue ${issueId} — re-triggering Coder`);
      await this.retriggerCoder(projectId, chatSessionId, issueId, feedback || 'UI test failed', 'ui-test');
    }
  }

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

    this.penTester.testIssue(ctx, issueId, mrIid, gitlabProjectId).catch((err) => {
      this.logger.error(`Pen Tester error: ${err.message}`);
    });
  }

  // ─── Pen Test Complete → Documenter ─────────────────────

  @OnEvent('agent.penTestComplete')
  async handlePenTestComplete(payload: {
    projectId: string;
    chatSessionId: string;
    issueId: string;
    mrIid: number;
    gitlabProjectId: number;
    passed: boolean;
    feedback?: string;
  }) {
    const { projectId, chatSessionId, issueId, mrIid, gitlabProjectId, passed, feedback } = payload;

    if (passed) {
      this.logger.log(`Pen test passed for issue ${issueId} — starting Documenter`);
      try {
        await this.startDocumenter(projectId, chatSessionId, issueId, mrIid, gitlabProjectId);
      } catch (err) {
        this.logger.error(`Failed to start Documenter: ${err.message}`);
      }
    } else {
      this.logger.log(`Pen test failed for issue ${issueId} — re-triggering Coder`);
      await this.retriggerCoder(projectId, chatSessionId, issueId, feedback || 'Security test failed', 'security');
    }
  }

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

    this.documenter.documentIssue(ctx, issueId, mrIid, gitlabProjectId).catch((err) => {
      this.logger.error(`Documenter error: ${err.message}`);
    });
  }

  // ─── Docs Complete → Issue DONE ─────────────────────────

  @OnEvent('agent.docsComplete')
  async handleDocsComplete(payload: {
    projectId: string;
    chatSessionId: string;
    issueId: string;
    mrIid: number;
    gitlabProjectId: number;
  }) {
    const { issueId } = payload;
    this.logger.log(`Documentation complete for issue ${issueId} — pipeline finished`);
  }

  // ─── Shared: Re-trigger Coder ──────────────────────────

  private async retriggerCoder(
    projectId: string,
    chatSessionId: string,
    issueId: string,
    feedback: string,
    feedbackSource: 'review' | 'pipeline' | 'user' | 'functional-test' | 'ui-test' | 'security',
  ): Promise<void> {
    const MAX_FIX_ATTEMPTS = 5;
    try {
      // Check how many FIX_CODE tasks already exist for this issue
      const fixCount = await this.prisma.agentTask.count({
        where: { issueId, type: AgentTaskType.FIX_CODE },
      });

      if (fixCount >= MAX_FIX_ATTEMPTS) {
        this.logger.warn(`Issue ${issueId} has ${fixCount} fix attempts — stopping to prevent infinite loop`);
        // Move issue to a reviewable state instead of looping
        const maxRetryIssue = await this.prisma.issue.update({
          where: { id: issueId },
          data: { status: IssueStatus.IN_REVIEW },
          include: { project: { select: { gitlabProjectId: true } } },
        });
        if (maxRetryIssue.gitlabIid && maxRetryIssue.project.gitlabProjectId) {
          await this.gitlabService.syncStatusLabel(maxRetryIssue.project.gitlabProjectId, maxRetryIssue.gitlabIid, 'IN_REVIEW').catch(() => {});
        }
        return;
      }

      this.logger.log(`Re-triggering Coder for issue ${issueId} (attempt ${fixCount + 1}/${MAX_FIX_ATTEMPTS})`);

      let coderInstance = await this.prisma.agentInstance.findFirst({
        where: { projectId, role: AgentRole.CODER, status: { in: [AgentStatus.IDLE, AgentStatus.WORKING] } },
      });

      if (!coderInstance) {
        const config = this.settings.getAgentRoleConfig('CODER');
        coderInstance = await this.prisma.agentInstance.create({
          data: {
            projectId,
            role: AgentRole.CODER,
            provider: config.provider as any,
            model: config.model,
            status: AgentStatus.IDLE,
          },
        });
      }

      const agentTask = await this.prisma.agentTask.create({
        data: {
          agentId: coderInstance.id,
          issueId,
          type: AgentTaskType.FIX_CODE,
          status: AgentTaskStatus.RUNNING,
          startedAt: new Date(),
        },
      });

      const ctx = {
        projectId,
        agentInstanceId: coderInstance.id,
        agentTaskId: agentTask.id,
        chatSessionId,
      };

      this.coder.fixIssue(ctx, issueId, feedback, feedbackSource as any).catch((err) => {
        this.logger.error(`Coder fix (${feedbackSource}) error: ${err.message}`);
      });
    } catch (err) {
      this.logger.error(`retriggerCoder error: ${err.message}`);
    }
  }
}
