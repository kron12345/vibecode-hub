import { Injectable, Logger, NotFoundException, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
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
import {
  AgentRole,
  AgentStatus,
  AgentTaskType,
  AgentTaskStatus,
  IssueStatus,
  ProjectStatus,
} from '@prisma/client';

/** Default: check for stuck tasks every 5 minutes */
const STUCK_CHECK_INTERVAL_MS = 5 * 60 * 1000;
/** Default: tasks with no activity for > 30 minutes are considered stuck */
const DEFAULT_INACTIVITY_TIMEOUT_MINUTES = 30;

@Injectable()
export class AgentOrchestratorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentOrchestratorService.name);
  private stuckCheckTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * In-memory lock to prevent race conditions when starting agents.
   * JS is single-threaded, so synchronous Set operations are atomic.
   * The lock is held between hasActiveAgent() check and agent creation.
   */
  private readonly startingAgents = new Set<string>();

  private acquireStartLock(projectId: string, role: AgentRole): boolean {
    const key = `${projectId}:${role}`;
    if (this.startingAgents.has(key)) {
      this.logger.warn(`${role} start already in progress for project ${projectId} — skipping duplicate`);
      return false;
    }
    this.startingAgents.add(key);
    return true;
  }

  private releaseStartLock(projectId: string, role: AgentRole): void {
    this.startingAgents.delete(`${projectId}:${role}`);
  }

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

  onModuleInit() {
    this.stuckCheckTimer = setInterval(() => {
      this.cleanupStuckTasks().catch((err) => {
        this.logger.error(`Stuck task cleanup failed: ${err.message}`);
      });
    }, STUCK_CHECK_INTERVAL_MS);
    this.logger.log('Stuck task cleanup scheduled (every 5 min)');
  }

  onModuleDestroy() {
    if (this.stuckCheckTimer) {
      clearInterval(this.stuckCheckTimer);
      this.stuckCheckTimer = null;
    }
  }

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

    if (!this.acquireStartLock(projectId, AgentRole.DEVOPS)) return;
    try {
      if (await this.hasActiveAgent(projectId, AgentRole.DEVOPS)) return;
      this.logger.log(`Interview complete for project ${projectId} — starting DevOps setup`);
      await this.startDevopsSetup(projectId, chatSessionId);
    } catch (err) {
      this.logger.error(`Failed to start DevOps setup: ${err.message}`);
    } finally {
      this.releaseStartLock(projectId, AgentRole.DEVOPS);
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

  // ─── Architect Agent ──────────────────────────────────────────

  /**
   * Handle DevOps completion — start Architect Phase A (architecture design).
   */
  @OnEvent('agent.devopsComplete')
  async handleDevopsComplete(payload: {
    projectId: string;
    chatSessionId: string;
  }) {
    const { projectId, chatSessionId } = payload;

    if (!this.acquireStartLock(projectId, AgentRole.ARCHITECT)) return;
    try {
      if (await this.hasActiveAgent(projectId, AgentRole.ARCHITECT)) return;
      this.logger.log(`DevOps complete for project ${projectId} — starting Architect (Phase A)`);
      await this.startArchitectDesign(projectId, chatSessionId);
    } catch (err) {
      this.logger.error(`Failed to start Architect: ${err.message}`);
    } finally {
      this.releaseStartLock(projectId, AgentRole.ARCHITECT);
    }
  }

  /**
   * Start the Architect agent for Phase A: architecture design.
   */
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

  /**
   * Handle architecture design completion — start Issue Compiler.
   */
  @OnEvent('agent.architectDesignComplete')
  async handleArchitectDesignComplete(payload: {
    projectId: string;
    chatSessionId: string;
  }) {
    const { projectId, chatSessionId } = payload;

    if (!this.acquireStartLock(projectId, AgentRole.ISSUE_COMPILER)) return;
    try {
      if (await this.hasActiveAgent(projectId, AgentRole.ISSUE_COMPILER)) return;
      this.logger.log(`Architecture design complete for project ${projectId} — starting Issue Compiler`);
      await this.startIssueCompilation(projectId, chatSessionId);
    } catch (err) {
      this.logger.error(`Failed to start Issue Compiler: ${err.message}`);
    } finally {
      this.releaseStartLock(projectId, AgentRole.ISSUE_COMPILER);
    }
  }

  // ─── Issue Compiler Agent ───────────────────────────────────

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

  // ─── Architect Phase B: Issue Grounding ─────────────────────

  /**
   * Handle issue compilation completion — start Architect Phase B (grounding).
   */
  @OnEvent('agent.issueCompilerComplete')
  async handleIssueCompilerComplete(payload: {
    projectId: string;
    chatSessionId: string;
  }) {
    const { projectId, chatSessionId } = payload;

    if (!this.acquireStartLock(projectId, AgentRole.ARCHITECT)) return;
    try {
      if (await this.hasActiveAgent(projectId, AgentRole.ARCHITECT)) return;
      this.logger.log(`Issue compilation complete for project ${projectId} — starting Architect (Phase B: Grounding)`);
      await this.startArchitectGrounding(projectId, chatSessionId);
    } catch (err) {
      this.logger.error(`Failed to start Architect grounding: ${err.message}`);
    } finally {
      this.releaseStartLock(projectId, AgentRole.ARCHITECT);
    }
  }

  /**
   * Start the Architect agent for Phase B: issue grounding.
   */
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

  /**
   * Handle architect grounding completion — start Coder Agent.
   */
  @OnEvent('agent.architectGroundingComplete')
  async handleArchitectGroundingComplete(payload: {
    projectId: string;
    chatSessionId: string;
  }) {
    const { projectId, chatSessionId } = payload;

    if (!this.acquireStartLock(projectId, AgentRole.CODER)) return;
    try {
      if (await this.hasActiveAgent(projectId, AgentRole.CODER)) return;
      this.logger.log(`Architect grounding complete for project ${projectId} — starting Coder Agent`);
      await this.startCoding(projectId, chatSessionId);
    } catch (err) {
      this.logger.error(`Failed to start Coder Agent: ${err.message}`);
    } finally {
      this.releaseStartLock(projectId, AgentRole.CODER);
    }
  }

  // ─── Coder Agent ──────────────────────────────────────────

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
      this.logger.warn(`No MR for issue ${issueId} — skipping pipeline, marking NEEDS_REVIEW`);
      await this.prisma.issue.update({
        where: { id: issueId },
        data: { status: IssueStatus.NEEDS_REVIEW },
      });

      // Sequential pipeline: skip this issue, trigger Coder for the next open one
      const nextOpen = await this.prisma.issue.findFirst({
        where: { projectId, status: IssueStatus.OPEN, parentId: null },
      });
      if (nextOpen) {
        this.logger.log(`No MR for ${issueId} — moving to next issue ${nextOpen.id}`);
        try {
          await this.startCoding(projectId, chatSessionId);
        } catch (err) {
          this.logger.error(`Failed to start Coder for next issue: ${err.message}`);
        }
      }
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

  /**
   * Handle coding failure — skip to next open issue in sequential pipeline.
   */
  @OnEvent('agent.codingFailed')
  async handleCodingFailed(payload: {
    projectId: string;
    chatSessionId: string;
    issueId: string;
  }) {
    const { projectId, chatSessionId, issueId } = payload;

    const nextOpen = await this.prisma.issue.findFirst({
      where: { projectId, status: IssueStatus.OPEN, parentId: null },
    });

    if (nextOpen) {
      this.logger.log(`Coding failed for ${issueId} — moving to next issue ${nextOpen.id}`);
      try {
        await this.startCoding(projectId, chatSessionId);
      } catch (err) {
        this.logger.error(`Failed to start Coder for next issue after failure: ${err.message}`);
      }
    } else {
      this.logger.log(`Coding failed for ${issueId} — no more open issues`);
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
    await this.retriggerCoder(projectId, chatSessionId, issueId, feedback, 'review');
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

    // Re-trigger Coder via centralized retrigger (respects maxFixAttempts)
    await this.retriggerCoder(projectId, chatSession.id, issue.id, failureSummary, 'pipeline');
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

    // Re-trigger Coder via centralized retrigger (respects maxFixAttempts)
    await this.retriggerCoder(projectId, chatSession.id, issueId, `User feedback from ${authorName}:\n\n${content}`, 'user');
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
    const { issueId, mrIid, gitlabProjectId, projectId, chatSessionId } = payload;
    const pipelineConfig = this.settings.getPipelineConfig();
    const mergeConfig = pipelineConfig.merge ?? {
      autoMerge: true, method: 'merge' as const, removeSourceBranch: true,
      requireApproval: false, closeIssueOnMerge: true,
    };

    this.logger.log(`Documentation complete for issue ${issueId} — merge config: ${JSON.stringify(mergeConfig)}`);

    // If manual approval required, emit suggestion and wait
    if (mergeConfig.requireApproval) {
      this.logger.log(`Merge requires approval — waiting for user action on MR !${mrIid}`);
      // Emit chat suggestions for merge approval
      this.chatGateway.emitToSession(chatSessionId, 'chatSuggestions', {
        chatSessionId,
        suggestions: ['✅ Merge', '⚠️ Review first', '❌ Reject MR'],
      });
      // Store pending merge info on the issue for later approval
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

    // Auto-merge the MR with retry for transient failures
    const MAX_MERGE_RETRIES = 3;
    const RETRY_DELAY_MS = 5_000;
    let merged = false;

    for (let attempt = 1; attempt <= MAX_MERGE_RETRIES; attempt++) {
      try {
        await this.gitlabService.acceptMergeRequest(gitlabProjectId, mrIid, {
          squash: mergeConfig.method === 'squash',
          removeSourceBranch: mergeConfig.removeSourceBranch,
        });
        this.logger.log(`MR !${mrIid} merged (method: ${mergeConfig.method}) for issue ${issueId}`);
        merged = true;
        break;
      } catch (mergeErr) {
        const msg = mergeErr.message ?? String(mergeErr);
        const isConflict = /conflict|cannot be merged|merge_request_not_mergeable/i.test(msg);

        if (isConflict) {
          this.logger.error(`MR !${mrIid} has merge conflicts — needs manual resolution: ${msg}`);
          await this.prisma.issue.update({
            where: { id: issueId },
            data: { status: IssueStatus.NEEDS_REVIEW },
          });
          break;
        }

        if (attempt < MAX_MERGE_RETRIES) {
          this.logger.warn(`Merge attempt ${attempt}/${MAX_MERGE_RETRIES} failed for MR !${mrIid}: ${msg} — retrying in ${RETRY_DELAY_MS / 1000}s`);
          await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        } else {
          this.logger.error(`All ${MAX_MERGE_RETRIES} merge attempts failed for MR !${mrIid}: ${msg}`);
          await this.prisma.issue.update({
            where: { id: issueId },
            data: { status: IssueStatus.NEEDS_REVIEW },
          });
        }
      }
    }

    if (merged) {
      // Mark issue as DONE
      await this.prisma.issue.update({
        where: { id: issueId },
        data: { status: IssueStatus.DONE },
      });

      // Post-merge: close GitLab issue if configured
      if (mergeConfig.closeIssueOnMerge) {
        const issue = await this.prisma.issue.findUnique({
          where: { id: issueId },
          select: { gitlabIid: true },
        });
        if (issue?.gitlabIid) {
          try {
            await this.gitlabService.closeIssue(gitlabProjectId, issue.gitlabIid);
            this.logger.log(`Closed GitLab issue #${issue.gitlabIid} after merge`);
          } catch (err) {
            this.logger.warn(`Failed to close GitLab issue: ${err.message}`);
          }
        }
      }

      // Pull latest base branch in the workspace so the Coder has the updated code
      const project = await this.prisma.project.findUnique({ where: { id: projectId } });
      if (project) {
        const baseBranch = project.workBranch || 'main';
        const workspace = require('path').resolve(
          this.settings.devopsWorkspacePath,
          project.slug,
        );
        try {
          const { execFile } = require('child_process');
          const { promisify } = require('util');
          const execFileAsync = promisify(execFile);
          await execFileAsync('git', ['checkout', baseBranch], { cwd: workspace, timeout: 10_000 });
          await execFileAsync('git', ['pull', '--ff-only'], { cwd: workspace, timeout: 30_000 });
          this.logger.log(`Pulled latest ${baseBranch} in workspace ${workspace}`);
        } catch (pullErr) {
          this.logger.warn(`Failed to pull ${baseBranch} in workspace: ${pullErr.message}`);
        }
      }

      // Sequential pipeline: trigger Coder for the next open issue
      const nextOpen = await this.prisma.issue.findFirst({
        where: { projectId, status: IssueStatus.OPEN, parentId: null },
      });
      if (nextOpen) {
        this.logger.log(`Issue ${issueId} merged — ${nextOpen.id} is next in queue, triggering Coder`);
        try {
          await this.startCoding(projectId, chatSessionId);
        } catch (err) {
          this.logger.error(`Failed to start Coder for next issue: ${err.message}`);
        }
      } else {
        this.logger.log(`Issue ${issueId} merged — no more open issues, pipeline complete!`);
        this.chatGateway.emitToSession(chatSessionId, 'chatSuggestions', {
          chatSessionId,
          suggestions: ['🎉 All issues done!', '📋 Show summary'],
        });
      }
    }
  }

  // ─── Shared: Re-trigger Coder ──────────────────────────

  private async retriggerCoder(
    projectId: string,
    chatSessionId: string,
    issueId: string,
    feedback: string,
    feedbackSource: 'review' | 'pipeline' | 'user' | 'functional-test' | 'ui-test' | 'security',
  ): Promise<void> {
    const pipelineCfg = this.settings.getPipelineConfig();
    const maxAttempts = pipelineCfg.maxFixAttempts ?? 20;

    try {
      // Check how many FIX_CODE tasks already exist for this issue
      const fixCount = await this.prisma.agentTask.count({
        where: { issueId, type: AgentTaskType.FIX_CODE },
      });

      if (fixCount >= maxAttempts) {
        this.logger.warn(`Issue ${issueId} has ${fixCount}/${maxAttempts} fix attempts — needs manual review`);

        // Move issue to NEEDS_REVIEW
        const stoppedIssue = await this.prisma.issue.update({
          where: { id: issueId },
          data: { status: IssueStatus.NEEDS_REVIEW },
          include: { project: { select: { gitlabProjectId: true } } },
        });

        // Sync status label + post explanatory comment to GitLab
        if (stoppedIssue.gitlabIid && stoppedIssue.project.gitlabProjectId) {
          await this.gitlabService.syncStatusLabel(
            stoppedIssue.project.gitlabProjectId, stoppedIssue.gitlabIid, 'NEEDS_REVIEW',
          ).catch(() => {});
          await this.gitlabService.createIssueNote(
            stoppedIssue.project.gitlabProjectId,
            stoppedIssue.gitlabIid,
            `⚠️ **Max fix attempts reached** (${fixCount}/${maxAttempts})\n\n` +
            `This issue has been automatically moved to **Needs Review** after ${fixCount} fix attempts ` +
            `(last source: ${feedbackSource}). Manual intervention required.\n\n` +
            `Last feedback:\n> ${feedback.substring(0, 500)}`,
          ).catch(() => {});
        }
        return;
      }

      this.logger.log(`Re-triggering Coder for issue ${issueId} (attempt ${fixCount + 1}/${maxAttempts}, source: ${feedbackSource})`);

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

  // ─── Stuck Task Cleanup ──────────────────────────────────

  /**
   * Periodically checks for RUNNING tasks that show no recent activity.
   *
   * IMPORTANT: Agents can legitimately run for a very long time (e.g. deepseek-r1
   * reasoning, large codebase analysis). We NEVER kill a task just because it's
   * been running long. Instead, we check for INACTIVITY — no new AgentLog entries
   * and no ChatMessage updates within the timeout window.
   *
   * A task is only considered stuck if:
   * 1. It has been RUNNING for at least the inactivity timeout, AND
   * 2. There are NO recent AgentLog entries for this task, AND
   * 3. There are NO recent ChatMessages linked to this task
   *
   * This ensures we only clean up truly dead tasks, not slow-but-working ones.
   */
  async cleanupStuckTasks(): Promise<void> {
    const inactivityMinutes = parseInt(
      this.settings.get('pipeline.stuckTimeoutMinutes', '', String(DEFAULT_INACTIVITY_TIMEOUT_MINUTES)),
      10,
    ) || DEFAULT_INACTIVITY_TIMEOUT_MINUTES;

    const cutoff = new Date(Date.now() - inactivityMinutes * 60 * 1000);

    // Find all RUNNING tasks that started before the cutoff
    const candidates = await this.prisma.agentTask.findMany({
      where: {
        status: AgentTaskStatus.RUNNING,
        startedAt: { lt: cutoff },
      },
      include: {
        agent: { select: { id: true, role: true, projectId: true } },
        issue: { select: { id: true, title: true, gitlabIid: true, status: true } },
      },
    });

    if (candidates.length === 0) return;

    // For each candidate, check if there's been any recent activity
    const stuckTasks: typeof candidates = [];

    for (const task of candidates) {
      // Check 1: Recent AgentLog entries for this task
      const recentLog = await this.prisma.agentLog.findFirst({
        where: {
          agentTaskId: task.id,
          createdAt: { gt: cutoff },
        },
        orderBy: { createdAt: 'desc' },
      });

      if (recentLog) {
        // Agent is still writing logs — it's alive, skip
        continue;
      }

      // Check 2: Recent ChatMessages linked to this task
      const recentMessage = await this.prisma.chatMessage.findFirst({
        where: {
          agentTaskId: task.id,
          createdAt: { gt: cutoff },
        },
        orderBy: { createdAt: 'desc' },
      });

      if (recentMessage) {
        // Agent is still sending chat messages — it's alive, skip
        continue;
      }

      // No recent activity → this task is genuinely stuck
      stuckTasks.push(task);
    }

    if (stuckTasks.length === 0) return;

    this.logger.warn(
      `Found ${stuckTasks.length} stuck task(s) (no activity for ${inactivityMinutes}+ min) ` +
      `out of ${candidates.length} long-running candidate(s)`,
    );

    for (const task of stuckTasks) {
      try {
        // Get the last activity timestamp for logging
        const lastLog = await this.prisma.agentLog.findFirst({
          where: { agentTaskId: task.id },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true },
        });

        await this.prisma.agentTask.update({
          where: { id: task.id },
          data: {
            status: AgentTaskStatus.FAILED,
            completedAt: new Date(),
            output: {
              error: `Task inactive for ${inactivityMinutes}+ minutes (last activity: ${lastLog?.createdAt?.toISOString() ?? 'none'})`,
            } as any,
          },
        });

        if (task.agent) {
          await this.prisma.agentInstance.update({
            where: { id: task.agent.id },
            data: { status: AgentStatus.IDLE },
          });
        }

        // Reset issue to OPEN if it was IN_PROGRESS (so it can be retried)
        if (task.issue && task.issue.status === IssueStatus.IN_PROGRESS) {
          await this.prisma.issue.update({
            where: { id: task.issue.id },
            data: { status: IssueStatus.OPEN },
          });
        }

        this.logger.warn(
          `Cleaned up stuck task ${task.id} (${task.type}, agent: ${task.agent?.role ?? '?'}, ` +
          `issue: ${task.issue?.title ?? 'N/A'}, last activity: ${lastLog?.createdAt?.toISOString() ?? 'none'})`,
        );
      } catch (err) {
        this.logger.error(`Failed to cleanup stuck task ${task.id}: ${err.message}`);
      }
    }

    // Also reset any WORKING/WAITING agents that have no RUNNING tasks
    // (e.g. agent crashed mid-task without updating its own status)
    const orphanedAgents = await this.prisma.agentInstance.findMany({
      where: {
        status: { in: [AgentStatus.WORKING, AgentStatus.WAITING] },
        tasks: {
          none: { status: AgentTaskStatus.RUNNING },
        },
      },
    });

    for (const agent of orphanedAgents) {
      await this.prisma.agentInstance.update({
        where: { id: agent.id },
        data: { status: AgentStatus.IDLE },
      });
      this.logger.warn(`Reset orphaned agent ${agent.id} (${agent.role}) from ${agent.status} to IDLE`);
    }
  }
}
