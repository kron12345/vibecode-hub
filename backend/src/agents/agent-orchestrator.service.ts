import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import { ChatService } from '../chat/chat.service';
import { ChatGateway } from '../chat/chat.gateway';
import { SystemSettingsService } from '../settings/system-settings.service';
import { GitlabService } from '../gitlab/gitlab.service';
import { PipelineFlowService } from './pipeline-flow.service';
import { PipelineRetryService } from './pipeline-retry.service';
import { PipelineCleanupService } from './pipeline-cleanup.service';
import { FeatureInterviewResult } from './interviewer/interview-result.interface';
import {
  AgentRole,
  AgentStatus,
  AgentTaskType,
  AgentTaskStatus,
  ChatSessionType,
  IssueStatus,
  ProjectStatus,
  SessionStatus,
} from '@prisma/client';

/**
 * Thin event-routing layer. Delegates all heavy logic to:
 * - PipelineFlowService  — agent lifecycle (start, complete)
 * - PipelineRetryService — fix loops, failure/resume
 * - PipelineCleanupService — zombie/stuck cleanup
 */
@Injectable()
export class AgentOrchestratorService {
  private readonly logger = new Logger(AgentOrchestratorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly chatService: ChatService,
    private readonly chatGateway: ChatGateway,
    private readonly settings: SystemSettingsService,
    private readonly gitlabService: GitlabService,
    private readonly flow: PipelineFlowService,
    private readonly retry: PipelineRetryService,
    private readonly cleanup: PipelineCleanupService,
  ) {}

  // ─── Public API (delegated) ─────────────────────────────────

  startInterview(projectId: string) {
    return this.flow.startInterview(projectId);
  }

  startDevopsSetup(projectId: string, chatSessionId: string) {
    return this.flow.startDevopsSetup(projectId, chatSessionId);
  }

  startArchitectDesign(projectId: string, chatSessionId: string) {
    return this.flow.startArchitectDesign(projectId, chatSessionId);
  }

  startIssueCompilation(projectId: string, chatSessionId: string) {
    return this.flow.startIssueCompilation(projectId, chatSessionId);
  }

  startCoding(projectId: string, chatSessionId: string) {
    return this.flow.startCoding(projectId, chatSessionId);
  }

  startCodeReview(
    projectId: string,
    chatSessionId: string,
    issueId: string,
    mrIid: number,
    gitlabProjectId: number,
  ) {
    return this.flow.startCodeReview(
      projectId,
      chatSessionId,
      issueId,
      mrIid,
      gitlabProjectId,
    );
  }

  startFunctionalTest(
    projectId: string,
    chatSessionId: string,
    issueId: string,
    mrIid: number,
    gitlabProjectId: number,
  ) {
    return this.flow.startFunctionalTest(
      projectId,
      chatSessionId,
      issueId,
      mrIid,
      gitlabProjectId,
    );
  }

  startUiTest(
    projectId: string,
    chatSessionId: string,
    issueId: string,
    mrIid: number,
    gitlabProjectId: number,
  ) {
    return this.flow.startUiTest(
      projectId,
      chatSessionId,
      issueId,
      mrIid,
      gitlabProjectId,
    );
  }

  startPenTest(
    projectId: string,
    chatSessionId: string,
    issueId: string,
    mrIid: number,
    gitlabProjectId: number,
  ) {
    return this.flow.startPenTest(
      projectId,
      chatSessionId,
      issueId,
      mrIid,
      gitlabProjectId,
    );
  }

  startDocumenter(
    projectId: string,
    chatSessionId: string,
    issueId: string,
    mrIid: number,
    gitlabProjectId: number,
  ) {
    return this.flow.startDocumenter(
      projectId,
      chatSessionId,
      issueId,
      mrIid,
      gitlabProjectId,
    );
  }

  getProjectAgentStatus(projectId: string) {
    return this.flow.getProjectAgentStatus(projectId);
  }

  getLatestPipelineFailure(projectId: string, chatSessionId: string) {
    return this.retry.getLatestPipelineFailure(projectId, chatSessionId);
  }

  resumePipelineFromFailedTask(
    projectId: string,
    chatSessionId: string,
    failedTaskId?: string,
  ) {
    return this.retry.resumePipelineFromFailedTask(
      projectId,
      chatSessionId,
      failedTaskId,
    );
  }

  // ─── User Message Routing ──────────────────────────────────

  @OnEvent('chat.userMessage')
  async handleUserMessage(payload: { chatSessionId: string; content: string }) {
    const { chatSessionId, content } = payload;

    const chatSession = await this.prisma.chatSession.findUnique({
      where: { id: chatSessionId },
      select: { projectId: true, type: true, status: true },
    });

    if (!chatSession) return;

    if (chatSession.type === ChatSessionType.DEV_SESSION) {
      if (chatSession.status !== SessionStatus.ACTIVE) {
        this.logger.debug(
          `Ignoring message for non-active dev session ${chatSessionId}`,
        );
        return;
      }

      const activeFeatureInterviewer =
        await this.prisma.agentInstance.findFirst({
          where: {
            projectId: chatSession.projectId,
            role: AgentRole.INTERVIEWER,
            status: {
              in: [AgentStatus.WAITING, AgentStatus.WORKING, AgentStatus.ERROR],
            },
          },
          include: {
            tasks: {
              where: {
                status: AgentTaskStatus.RUNNING,
                type: AgentTaskType.FEATURE_INTERVIEW,
              },
              take: 1,
            },
          },
        });

      if (
        activeFeatureInterviewer &&
        activeFeatureInterviewer.tasks.length > 0
      ) {
        if (activeFeatureInterviewer.status === AgentStatus.ERROR) {
          await this.prisma.agentInstance.update({
            where: { id: activeFeatureInterviewer.id },
            data: { status: AgentStatus.WAITING },
          });
          this.logger.log(`Recovered feature INTERVIEWER from ERROR state`);
        }
        const ctx = {
          projectId: chatSession.projectId,
          agentInstanceId: activeFeatureInterviewer.id,
          agentTaskId: activeFeatureInterviewer.tasks[0].id,
          chatSessionId,
        };
        this.logger.debug(`Routing dev session message to feature interviewer`);
        this.flow.continueFeatureInterview(ctx);
      }
      return;
    }

    // INFRASTRUCTURE chat
    const activeInterviewer = await this.prisma.agentInstance.findFirst({
      where: {
        projectId: chatSession.projectId,
        role: AgentRole.INTERVIEWER,
        status: {
          in: [AgentStatus.WAITING, AgentStatus.WORKING, AgentStatus.ERROR],
        },
      },
      include: {
        tasks: {
          where: {
            status: AgentTaskStatus.RUNNING,
            type: AgentTaskType.INTERVIEW,
          },
          take: 1,
        },
      },
    });

    if (activeInterviewer && activeInterviewer.tasks.length > 0) {
      if (activeInterviewer.status === AgentStatus.ERROR) {
        await this.prisma.agentInstance.update({
          where: { id: activeInterviewer.id },
          data: { status: AgentStatus.WAITING },
        });
        this.logger.log(`Recovered INTERVIEWER from ERROR state`);
      }
      const ctx = {
        projectId: chatSession.projectId,
        agentInstanceId: activeInterviewer.id,
        agentTaskId: activeInterviewer.tasks[0].id,
        chatSessionId,
      };
      this.logger.debug(
        `Routing infrastructure message to project interviewer`,
      );
      this.flow.continueInterview(ctx);
      return;
    }

    // INFRASTRUCTURE + READY → YOLO mode
    const project = await this.prisma.project.findUnique({
      where: { id: chatSession.projectId },
      select: { status: true },
    });

    if (project?.status === ProjectStatus.READY) {
      this.logger.log(
        `YOLO mode: routing infrastructure message to DevOps agent`,
      );
      await this.flow.startInfraCommand(
        chatSession.projectId,
        chatSessionId,
        content,
      );
    }
  }

  // ─── Infrastructure Pipeline Events ─────────────────────────

  @OnEvent('agent.interviewComplete')
  async handleInterviewComplete(payload: {
    projectId: string;
    chatSessionId: string;
  }) {
    const { projectId, chatSessionId } = payload;

    if (!this.flow.acquireStartLock(projectId, AgentRole.DEVOPS)) return;
    try {
      if (await this.flow.hasActiveAgent(projectId, AgentRole.DEVOPS)) return;
      this.logger.log(
        `Interview complete for project ${projectId} — starting DevOps setup`,
      );
      await this.flow.startDevopsSetup(projectId, chatSessionId);
    } catch (err) {
      this.logger.error(`Failed to start DevOps setup: ${err.message}`);
    } finally {
      this.flow.releaseStartLock(projectId, AgentRole.DEVOPS);
    }
  }

  @OnEvent('agent.devopsComplete')
  async handleDevopsComplete(payload: {
    projectId: string;
    chatSessionId: string;
  }) {
    const { projectId, chatSessionId } = payload;

    this.logger.log(
      `DevOps complete for project ${projectId} — infrastructure pipeline done.`,
    );

    const chatSession = await this.prisma.chatSession.findUnique({
      where: { id: chatSessionId },
    });
    if (chatSession) {
      await this.chatService.addMessage({
        chatSessionId,
        role: 'SYSTEM' as any,
        content:
          '✅ **Project setup complete!** The environment is ready.\n\n' +
          'This chat is now your **Infrastructure Chat** — use it to install packages, ' +
          'configure services, or make environment changes.\n\n' +
          'To start building features, create a **Dev Session** from the sidebar.',
      });
      this.chatGateway.emitToSession(chatSessionId, 'projectUpdated', {
        projectId,
        status: ProjectStatus.READY,
      });
    }

    this.chatGateway.emitToSession(chatSessionId, 'chatSuggestions', {
      chatSessionId,
      suggestions: [
        '📦 Install a package',
        '⚙️ Configure database',
        '🆕 Create Dev Session',
      ],
    });
  }

  // ─── Dev Session Pipeline Events ────────────────────────────

  @OnEvent('session.devSessionCreated')
  async handleDevSessionCreated(payload: {
    projectId: string;
    chatSessionId: string;
    sessionTitle: string;
  }) {
    const { projectId, chatSessionId, sessionTitle } = payload;

    if (!this.flow.acquireStartLock(projectId, AgentRole.INTERVIEWER)) return;
    try {
      this.logger.log(
        `Dev session created for project ${projectId} — starting feature interview`,
      );
      await this.flow.startFeatureInterview(
        projectId,
        chatSessionId,
        sessionTitle,
      );
    } catch (err) {
      this.logger.error(`Failed to start feature interview: ${err.message}`);
    } finally {
      this.flow.releaseStartLock(projectId, AgentRole.INTERVIEWER);
    }
  }

  @OnEvent('agent.featureInterviewComplete')
  async handleFeatureInterviewComplete(payload: {
    projectId: string;
    chatSessionId: string;
    featureResult: FeatureInterviewResult;
  }) {
    const { projectId, chatSessionId, featureResult } = payload;

    this.logger.log(
      `Feature interview complete for project ${projectId} — ` +
        `${featureResult.features.length} features captured, starting Architect`,
    );

    if (!this.flow.acquireStartLock(projectId, AgentRole.ARCHITECT)) return;
    try {
      if (await this.flow.hasActiveAgent(projectId, AgentRole.ARCHITECT))
        return;
      await this.flow.startArchitectDesign(projectId, chatSessionId);
    } catch (err) {
      this.logger.error(
        `Failed to start Architect after feature interview: ${err.message}`,
      );
    } finally {
      this.flow.releaseStartLock(projectId, AgentRole.ARCHITECT);
    }
  }

  @OnEvent('agent.architectDesignComplete')
  async handleArchitectDesignComplete(payload: {
    projectId: string;
    chatSessionId: string;
  }) {
    const { projectId, chatSessionId } = payload;

    if (!this.flow.acquireStartLock(projectId, AgentRole.ISSUE_COMPILER))
      return;
    try {
      if (await this.flow.hasActiveAgent(projectId, AgentRole.ISSUE_COMPILER))
        return;
      this.logger.log(
        `Architecture design complete for project ${projectId} — starting Issue Compiler`,
      );
      await this.flow.startIssueCompilation(projectId, chatSessionId);
    } catch (err) {
      this.logger.error(`Failed to start Issue Compiler: ${err.message}`);
    } finally {
      this.flow.releaseStartLock(projectId, AgentRole.ISSUE_COMPILER);
    }
  }

  @OnEvent('agent.issueCompilerComplete')
  async handleIssueCompilerComplete(payload: {
    projectId: string;
    chatSessionId: string;
  }) {
    const { projectId, chatSessionId } = payload;

    if (!this.flow.acquireStartLock(projectId, AgentRole.ARCHITECT)) return;
    try {
      if (await this.flow.hasActiveAgent(projectId, AgentRole.ARCHITECT))
        return;
      this.logger.log(
        `Issue compilation complete for project ${projectId} — starting Architect (Phase B: Grounding)`,
      );
      await this.flow.startArchitectGrounding(projectId, chatSessionId);
    } catch (err) {
      this.logger.error(`Failed to start Architect grounding: ${err.message}`);
    } finally {
      this.flow.releaseStartLock(projectId, AgentRole.ARCHITECT);
    }
  }

  @OnEvent('agent.architectGroundingComplete')
  async handleArchitectGroundingComplete(payload: {
    projectId: string;
    chatSessionId: string;
  }) {
    const { projectId, chatSessionId } = payload;

    if (!this.flow.acquireStartLock(projectId, AgentRole.CODER)) return;
    try {
      if (await this.flow.hasActiveAgent(projectId, AgentRole.CODER)) return;
      this.logger.log(
        `Architect grounding complete for project ${projectId} — starting Coder Agent`,
      );
      await this.flow.startCoding(projectId, chatSessionId);
    } catch (err) {
      this.logger.error(`Failed to start Coder Agent: ${err.message}`);
    } finally {
      this.flow.releaseStartLock(projectId, AgentRole.CODER);
    }
  }

  // ─── Coding → Review Pipeline ──────────────────────────────

  @OnEvent('agent.codingComplete')
  async handleCodingComplete(payload: {
    projectId: string;
    chatSessionId: string;
    issueId: string;
    gitlabIid: number;
    mrIid?: number;
    gitlabProjectId: number;
    branch: string;
    noChanges?: boolean;
  }) {
    const { projectId, chatSessionId, issueId, mrIid, gitlabProjectId } =
      payload;

    if (payload.noChanges) {
      this.logger.warn(
        `Fix for issue ${issueId} produced 0 code changes — skipping review, re-triggering Coder`,
      );
      await this.retry.retriggerCoder(
        projectId,
        chatSessionId,
        issueId,
        'Previous fix attempt made ZERO code changes. You MUST actually edit the source files to fix the issues. Read the files, understand the problem, and make concrete changes.',
        'review',
      );
      return;
    }

    if (!mrIid) {
      this.logger.warn(
        `No MR for issue ${issueId} — skipping pipeline, marking NEEDS_REVIEW`,
      );
      await this.prisma.issue.update({
        where: { id: issueId },
        data: { status: IssueStatus.NEEDS_REVIEW },
      });

      const chatSessionFilter = await this.flow.getSessionFilter(chatSessionId);
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
          `No MR for ${issueId} — moving to next issue ${nextOpen.id}`,
        );
        try {
          await this.flow.startCoding(projectId, chatSessionId);
        } catch (err) {
          this.logger.error(
            `Failed to start Coder for next issue: ${err.message}`,
          );
        }
      }
      return;
    }

    const existingReview = await this.prisma.agentTask.findFirst({
      where: {
        issueId,
        type: AgentTaskType.REVIEW_CODE,
        status: AgentTaskStatus.RUNNING,
      },
    });
    if (existingReview) {
      this.logger.warn(
        `Code review already running for issue ${issueId} — skipping duplicate`,
      );
      return;
    }

    this.logger.log(
      `Coding complete for issue ${issueId} — starting Code Review`,
    );

    try {
      await this.flow.startCodeReview(
        projectId,
        chatSessionId,
        issueId,
        mrIid,
        gitlabProjectId,
      );
    } catch (err) {
      this.logger.error(`Failed to start Code Review: ${err.message}`);
    }
  }

  @OnEvent('agent.codingFailed')
  async handleCodingFailed(payload: {
    projectId: string;
    chatSessionId: string;
    issueId: string;
    isFixAttempt?: boolean;
    errorMessage?: string;
  }) {
    const { projectId, chatSessionId, issueId, errorMessage, isFixAttempt } =
      payload;
    const failureReason = errorMessage
      ? `Coder failure: ${errorMessage}`
      : `Coder ${isFixAttempt ? 'fix attempt' : 'implementation'} failed for issue ${issueId}`;

    this.logger.error(
      `Pipeline stop for session ${chatSessionId}: ${failureReason} (issue ${issueId}, fix=${Boolean(isFixAttempt)})`,
    );
    await this.cleanup.pausePipelineForSessionFailure(
      projectId,
      chatSessionId,
      issueId,
      failureReason,
    );
  }

  @OnEvent('agent.taskFailed')
  async handleAgentTaskFailed(payload: {
    projectId: string;
    chatSessionId: string;
    agentTaskId: string;
    agentRole: string;
    reason: string;
  }) {
    const { projectId, chatSessionId, agentRole, reason } = payload;
    this.logger.error(
      `Pipeline stop: ${agentRole} task failed in session ${chatSessionId}: ${reason}`,
    );

    const task = await this.prisma.agentTask.findUnique({
      where: { id: payload.agentTaskId },
      select: { issueId: true },
    });

    await this.cleanup.pausePipelineForSessionFailure(
      projectId,
      chatSessionId,
      task?.issueId ?? 'unknown',
      `${agentRole} failed: ${reason}`,
    );
  }

  @OnEvent('agent.reviewChangesRequested')
  async handleReviewChangesRequested(payload: {
    projectId: string;
    chatSessionId: string;
    issueId: string;
    feedback: string;
  }) {
    const { projectId, chatSessionId, issueId, feedback } = payload;
    this.logger.log(
      `Review changes requested for issue ${issueId} — re-triggering Coder`,
    );
    await this.retry.retriggerCoder(
      projectId,
      chatSessionId,
      issueId,
      feedback,
      'review',
    );
  }

  // ─── Pipeline CI/CD Feedback ────────────────────────────────

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

    const match = ref.match(/^feature\/(\d+)-/);
    if (!match) {
      this.logger.debug(`Pipeline failed on non-feature branch: ${ref}`);
      return;
    }

    const gitlabIid = parseInt(match[1], 10);
    this.logger.log(
      `Pipeline failed for feature branch ${ref} (issue #${gitlabIid})`,
    );

    const issue = await this.prisma.issue.findFirst({
      where: { projectId, gitlabIid },
    });

    if (!issue) {
      this.logger.warn(
        `No local issue for GitLab #${gitlabIid} in project ${projectId}`,
      );
      return;
    }

    let failureSummary = 'CI/CD pipeline failed.';
    try {
      const jobs = await this.gitlabService.getPipelineJobs(
        gitlabProjectId,
        pipelineId,
      );
      const failedJobs = jobs.filter((j) => j.status === 'failed').slice(0, 3);

      const logParts: string[] = [];
      for (const job of failedJobs) {
        try {
          const log = await this.gitlabService.getJobLog(
            gitlabProjectId,
            job.id,
          );
          logParts.push(
            `### Job: ${job.name} (${job.stage})\n\`\`\`\n${log.slice(-2000)}\n\`\`\``,
          );
        } catch {
          logParts.push(
            `### Job: ${job.name} (${job.stage})\n_Could not fetch log_`,
          );
        }
      }

      if (logParts.length > 0) {
        failureSummary = `CI/CD pipeline failed.\n\n${logParts.join('\n\n')}`;
      }
    } catch (err) {
      this.logger.warn(`Could not fetch pipeline job logs: ${err.message}`);
    }

    try {
      await this.gitlabService.createIssueNote(
        gitlabProjectId,
        gitlabIid,
        `❌ **CI/CD Pipeline failed** (Pipeline #${pipelineId})\n\n${failureSummary.substring(0, 3000)}`,
      );
    } catch {
      // Non-critical
    }

    await this.prisma.issue.update({
      where: { id: issue.id },
      data: { status: IssueStatus.IN_PROGRESS },
    });

    await this.gitlabService
      .syncStatusLabel(gitlabProjectId, gitlabIid, 'IN_PROGRESS')
      .catch(() => {}); // GitLab label sync is best-effort — failure doesn't affect pipeline

    const issueWithSession = await this.prisma.issue.findUnique({
      where: { id: issue.id },
      select: { chatSessionId: true },
    });
    let chatSessionId = issueWithSession?.chatSessionId;
    if (!chatSessionId) {
      const fallbackSession = await this.prisma.chatSession.findFirst({
        where: { projectId },
        orderBy: { createdAt: 'desc' },
      });
      chatSessionId = fallbackSession?.id;
    }

    if (!chatSessionId) return;

    await this.retry.retriggerCoder(
      projectId,
      chatSessionId,
      issue.id,
      failureSummary,
      'pipeline',
    );
  }

  // ─── User Comment Feedback ──────────────────────────────────

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

    const triggerStatuses: IssueStatus[] = [
      IssueStatus.DONE,
      IssueStatus.IN_REVIEW,
      IssueStatus.TESTING,
    ];

    if (!triggerStatuses.includes(issueStatus)) {
      this.logger.debug(
        `User comment on issue ${issueId} in status ${issueStatus} — ignoring`,
      );
      return;
    }

    this.logger.log(
      `User ${authorName} commented on issue ${issueId} (status: ${issueStatus}) — re-triggering Coder`,
    );

    const updatedIssue = await this.prisma.issue.update({
      where: { id: issueId },
      data: { status: IssueStatus.IN_PROGRESS },
      include: { project: { select: { gitlabProjectId: true } } },
    });

    if (updatedIssue.gitlabIid && updatedIssue.project.gitlabProjectId) {
      await this.gitlabService
        .syncStatusLabel(
          updatedIssue.project.gitlabProjectId,
          updatedIssue.gitlabIid,
          'IN_PROGRESS',
        )
        .catch(() => {}); // GitLab label sync is best-effort — failure doesn't affect pipeline
    }

    const issueWithSession = await this.prisma.issue.findUnique({
      where: { id: issueId },
      select: { chatSessionId: true },
    });
    let chatSessionForComment = issueWithSession?.chatSessionId;
    if (!chatSessionForComment) {
      const fallbackSession = await this.prisma.chatSession.findFirst({
        where: { projectId },
        orderBy: { createdAt: 'desc' },
      });
      chatSessionForComment = fallbackSession?.id;
    }

    if (!chatSessionForComment) return;

    await this.retry.retriggerCoder(
      projectId,
      chatSessionForComment,
      issueId,
      `User feedback from ${authorName}:\n\n${content}`,
      'user',
    );
  }

  // ─── Review → Testing → Docs Pipeline ──────────────────────

  @OnEvent('agent.reviewApproved')
  async handleReviewApproved(payload: {
    projectId: string;
    chatSessionId: string;
    issueId: string;
    mrIid: number;
    gitlabProjectId: number;
  }) {
    const { projectId, chatSessionId, issueId, mrIid, gitlabProjectId } =
      payload;
    this.logger.log(
      `Review approved for issue ${issueId} — starting Functional Tester`,
    );

    try {
      await this.flow.startFunctionalTest(
        projectId,
        chatSessionId,
        issueId,
        mrIid,
        gitlabProjectId,
      );
    } catch (err) {
      this.logger.error(`Failed to start Functional Tester: ${err.message}`);
    }
  }

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
    const {
      projectId,
      chatSessionId,
      issueId,
      mrIid,
      gitlabProjectId,
      passed,
      feedback,
    } = payload;

    if (passed) {
      this.logger.log(
        `Functional test passed for issue ${issueId} — starting UI Tester`,
      );
      try {
        await this.flow.startUiTest(
          projectId,
          chatSessionId,
          issueId,
          mrIid,
          gitlabProjectId,
        );
      } catch (err) {
        this.logger.error(`Failed to start UI Tester: ${err.message}`);
      }
    } else {
      this.logger.log(
        `Functional test failed for issue ${issueId} — re-triggering Coder`,
      );
      await this.retry.retriggerCoder(
        projectId,
        chatSessionId,
        issueId,
        feedback || 'Functional test failed',
        'functional-test',
      );
    }
  }

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
    const {
      projectId,
      chatSessionId,
      issueId,
      mrIid,
      gitlabProjectId,
      passed,
      feedback,
    } = payload;

    if (passed) {
      this.logger.log(
        `UI test passed for issue ${issueId} — starting Pen Tester`,
      );
      try {
        await this.flow.startPenTest(
          projectId,
          chatSessionId,
          issueId,
          mrIid,
          gitlabProjectId,
        );
      } catch (err) {
        this.logger.error(`Failed to start Pen Tester: ${err.message}`);
      }
    } else {
      this.logger.log(
        `UI test failed for issue ${issueId} — re-triggering Coder`,
      );
      await this.retry.retriggerCoder(
        projectId,
        chatSessionId,
        issueId,
        feedback || 'UI test failed',
        'ui-test',
      );
    }
  }

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
    const {
      projectId,
      chatSessionId,
      issueId,
      mrIid,
      gitlabProjectId,
      passed,
      feedback,
    } = payload;

    if (passed) {
      this.logger.log(
        `Pen test passed for issue ${issueId} — starting Documenter`,
      );
      try {
        await this.flow.startDocumenter(
          projectId,
          chatSessionId,
          issueId,
          mrIid,
          gitlabProjectId,
        );
      } catch (err) {
        this.logger.error(`Failed to start Documenter: ${err.message}`);
      }
    } else {
      this.logger.log(
        `Pen test failed for issue ${issueId} — re-triggering Coder`,
      );
      await this.retry.retriggerCoder(
        projectId,
        chatSessionId,
        issueId,
        feedback || 'Security test failed',
        'security',
      );
    }
  }

  @OnEvent('agent.docsComplete')
  async handleDocsComplete(payload: {
    projectId: string;
    chatSessionId: string;
    issueId: string;
    mrIid: number;
    gitlabProjectId: number;
  }) {
    const { issueId, mrIid, gitlabProjectId, projectId, chatSessionId } =
      payload;
    await this.flow.completeIssue(
      projectId,
      chatSessionId,
      issueId,
      mrIid,
      gitlabProjectId,
    );
  }

  // ─── Manual Trigger ─────────────────────────────────────────

  async triggerCodingForProject(projectId: string) {
    const session = await this.prisma.chatSession.findFirst({
      where: { projectId, type: 'DEV_SESSION', status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    });
    if (!session) throw new Error('No active dev session found');
    this.logger.log(
      `Manual pipeline trigger for project ${projectId}, session ${session.id}`,
    );
    await this.flow.startCoding(projectId, session.id);
  }
}
