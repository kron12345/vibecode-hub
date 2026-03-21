import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../settings/system-settings.service';
import { ChatService } from '../chat/chat.service';
import { ChatGateway } from '../chat/chat.gateway';
import { GitlabService } from '../gitlab/gitlab.service';
import { CoderAgent } from './coder/coder.agent';
import { LoopResolverService } from './loop-resolver/loop-resolver.service';
import { PipelineFlowService } from './pipeline-flow.service';
import {
  AgentRole,
  AgentStatus,
  AgentTaskType,
  AgentTaskStatus,
  IssueStatus,
} from '@prisma/client';

export type FeedbackSource =
  | 'review'
  | 'pipeline'
  | 'user'
  | 'functional-test'
  | 'ui-test'
  | 'security';

@Injectable()
export class PipelineRetryService {
  private readonly logger = new Logger(PipelineRetryService.name);

  /**
   * In-memory lock to prevent concurrent FIX_CODE tasks for the same issue.
   */
  private readonly fixingIssues = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SystemSettingsService,
    private readonly chatService: ChatService,
    private readonly chatGateway: ChatGateway,
    private readonly gitlabService: GitlabService,
    private readonly coder: CoderAgent,
    private readonly loopResolver: LoopResolverService,
    private readonly flow: PipelineFlowService,
  ) {}

  // ─── Re-trigger Coder ───────────────────────────────────────

  async retriggerCoder(
    projectId: string,
    chatSessionId: string,
    issueId: string,
    feedback: string,
    feedbackSource: FeedbackSource,
  ): Promise<void> {
    const fixLockKey = `${projectId}:${issueId}`;
    if (this.fixingIssues.has(fixLockKey)) {
      this.logger.warn(
        `FIX_CODE already in progress for issue ${issueId} — skipping duplicate (source: ${feedbackSource})`,
      );
      return;
    }
    this.fixingIssues.add(fixLockKey);

    const pipelineCfg = this.settings.getPipelineConfig();
    const globalMax = pipelineCfg.maxFixAttempts ?? 5;

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { maxFixAttempts: true },
    });
    const maxAttempts = project?.maxFixAttempts ?? globalMax;

    try {
      const activeFix = await this.prisma.agentTask.findFirst({
        where: {
          issueId,
          type: AgentTaskType.FIX_CODE,
          status: AgentTaskStatus.RUNNING,
        },
      });
      if (activeFix) {
        this.logger.warn(
          `FIX_CODE task ${activeFix.id} already RUNNING for issue ${issueId} — skipping`,
        );
        return;
      }

      const fixCount = await this.prisma.agentTask.count({
        where: { issueId, type: AgentTaskType.FIX_CODE },
      });

      if (fixCount >= maxAttempts) {
        this.logger.warn(
          `Issue ${issueId} has ${fixCount}/${maxAttempts} fix attempts — needs manual review`,
        );

        const stoppedIssue = await this.prisma.issue.update({
          where: { id: issueId },
          data: { status: IssueStatus.NEEDS_REVIEW },
          include: { project: { select: { gitlabProjectId: true } } },
        });

        await this.prisma.issue
          .updateMany({
            where: {
              parentId: issueId,
              status: { in: [IssueStatus.OPEN, IssueStatus.IN_PROGRESS] },
            },
            data: { status: IssueStatus.NEEDS_REVIEW },
          })
          .catch((err) => { this.logger.warn(`Failed to update sub-issue statuses: ${err.message}`); });

        if (stoppedIssue.gitlabIid && stoppedIssue.project.gitlabProjectId) {
          await this.gitlabService
            .syncStatusLabel(
              stoppedIssue.project.gitlabProjectId,
              stoppedIssue.gitlabIid,
              'NEEDS_REVIEW',
            )
            .catch(() => {}); // GitLab label sync is best-effort — failure doesn't affect pipeline
          await this.gitlabService
            .createIssueNote(
              stoppedIssue.project.gitlabProjectId,
              stoppedIssue.gitlabIid,
              `⚠️ **Max fix attempts reached** (${fixCount}/${maxAttempts})\n\n` +
                `This issue has been automatically moved to **Needs Review** after ${fixCount} fix attempts ` +
                `(last source: ${feedbackSource}). The MR was auto-merged so subsequent issues have access to this code.\n\n` +
                `Last feedback:\n> ${feedback.substring(0, 500)}`,
            )
            .catch(() => {}); // GitLab issue note is best-effort — failure doesn't affect pipeline
        }

        await this.autoMergeForNeedsReview(issueId, projectId, chatSessionId);

        const chatSessionFilter =
          await this.flow.getSessionFilter(chatSessionId);
        const nextOpen = await this.prisma.issue.findFirst({
          where: {
            projectId,
            status: IssueStatus.OPEN,
            parentId: null,
            ...chatSessionFilter,
          },
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        });
        if (nextOpen) {
          this.logger.log(
            `Issue ${issueId} at NEEDS_REVIEW (MR merged) — starting next issue ${nextOpen.id}`,
          );
          await this.flow.startCoding(projectId, chatSessionId);
        } else {
          this.logger.log(
            `Issue ${issueId} at NEEDS_REVIEW — no more open issues`,
          );
          this.chatGateway.emitToSession(chatSessionId, 'chatMessage', {
            chatSessionId,
            content: `⚠️ Issue at NEEDS_REVIEW and no more open issues. Pipeline paused.`,
            role: 'assistant',
          });
        }
        return;
      }

      this.logger.log(
        `Re-triggering Coder for issue ${issueId} (attempt ${fixCount + 1}/${maxAttempts}, source: ${feedbackSource})`,
      );

      // Loop Resolver
      const loopThreshold = pipelineCfg.loopResolverThreshold ?? 3;
      const loopEnabled = pipelineCfg.loopResolverEnabled !== false;
      if (
        loopEnabled &&
        fixCount >= loopThreshold &&
        fixCount % loopThreshold === 0
      ) {
        this.logger.log(
          `Loop threshold reached (${fixCount}/${loopThreshold}) for issue ${issueId} — running Loop Resolver`,
        );
        const analysis = await this.loopResolver.analyze(
          issueId,
          projectId,
          feedback,
          feedbackSource,
        );
        if (analysis.clarificationComment) {
          feedback = `--- LOOP RESOLVER CLARIFICATION ---\n${analysis.clarificationComment}\n\n--- ORIGINAL FEEDBACK ---\n${feedback}`;
        }
      }

      let coderInstance = await this.prisma.agentInstance.findFirst({
        where: {
          projectId,
          role: AgentRole.CODER,
          status: { in: [AgentStatus.IDLE, AgentStatus.WORKING] },
        },
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

      this.coder
        .fixIssue(ctx, issueId, feedback, feedbackSource as any)
        .catch((err) => {
          this.logger.error(
            `Coder fix (${feedbackSource}) error: ${err.message}`,
          );
        })
        .finally(() => {
          this.fixingIssues.delete(fixLockKey);
        });
    } catch (err) {
      this.logger.error(`retriggerCoder error: ${err.message}`);
      this.fixingIssues.delete(fixLockKey);
    }
  }

  // ─── Auto-Merge for NEEDS_REVIEW ────────────────────────────

  private async autoMergeForNeedsReview(
    issueId: string,
    projectId: string,
    chatSessionId: string,
  ): Promise<void> {
    try {
      const taskWithMr = await this.prisma.agentTask.findFirst({
        where: { issueId, gitlabMrIid: { not: null } },
        orderBy: { createdAt: 'desc' },
        select: { gitlabMrIid: true },
      });

      if (!taskWithMr?.gitlabMrIid) {
        this.logger.warn(
          `autoMergeForNeedsReview: No MR found for issue ${issueId} — skipping`,
        );
        return;
      }

      const project = await this.prisma.project.findUnique({
        where: { id: projectId },
        select: { gitlabProjectId: true, slug: true, workBranch: true },
      });
      if (!project?.gitlabProjectId) return;

      const mrIid = taskWithMr.gitlabMrIid;
      const pipelineConfig = this.settings.getPipelineConfig();
      const mergeConfig = pipelineConfig.merge ?? {
        autoMerge: true,
        method: 'merge' as const,
        removeSourceBranch: true,
        requireApproval: false,
        closeIssueOnMerge: true,
      };

      const MAX_RETRIES = 3;
      const RETRY_DELAY = 5_000;
      let merged = false;

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          await this.gitlabService.acceptMergeRequest(
            project.gitlabProjectId,
            mrIid,
            {
              squash: mergeConfig.method === 'squash',
              removeSourceBranch: mergeConfig.removeSourceBranch,
            },
          );
          this.logger.log(
            `autoMergeForNeedsReview: MR !${mrIid} merged for NEEDS_REVIEW issue ${issueId}`,
          );
          merged = true;
          break;
        } catch (err) {
          const msg = err.message ?? String(err);
          const isConflict =
            /conflict|cannot be merged|merge_request_not_mergeable/i.test(msg);

          if (isConflict) {
            this.logger.warn(
              `autoMergeForNeedsReview: MR !${mrIid} has conflicts — cannot auto-merge: ${msg}`,
            );
            return;
          }

          if (attempt < MAX_RETRIES) {
            this.logger.warn(
              `autoMergeForNeedsReview: Merge attempt ${attempt}/${MAX_RETRIES} failed: ${msg} — retrying`,
            );
            await new Promise((r) => setTimeout(r, RETRY_DELAY));
          } else {
            this.logger.error(
              `autoMergeForNeedsReview: All ${MAX_RETRIES} attempts failed for MR !${mrIid}: ${msg}`,
            );
            return;
          }
        }
      }

      if (!merged) return;

      await this.flow.pullLatestInWorkspace(projectId, chatSessionId);
    } catch (err) {
      this.logger.error(`autoMergeForNeedsReview error: ${err.message}`);
    }
  }

  // ─── Failure Summary + Resume ───────────────────────────────

  buildSessionFailureFilter(projectId: string, chatSessionId: string) {
    return {
      status: AgentTaskStatus.FAILED,
      agent: { projectId },
      OR: [
        { issue: { chatSessionId } },
        { chatMessages: { some: { chatSessionId } } },
      ],
    };
  }

  extractTaskFailureReason(task: {
    output?: unknown;
    logs?: Array<{ message: string }>;
    type?: AgentTaskType;
  }): string {
    const output = task.output as Record<string, unknown> | null;
    const directOutputReason =
      output && typeof output === 'object'
        ? (typeof output.error === 'string' && output.error) ||
          (typeof output.errorMessage === 'string' && output.errorMessage) ||
          (typeof output.message === 'string' && output.message) ||
          (typeof output.summary === 'string' && output.summary)
        : null;

    if (directOutputReason) return directOutputReason.substring(0, 1000);
    if (typeof task.output === 'string' && task.output.trim()) {
      return task.output.substring(0, 1000);
    }

    const latestLog = task.logs?.[0]?.message?.trim();
    if (latestLog) return latestLog.substring(0, 1000);

    return `${task.type ?? 'UNKNOWN_TASK'} failed without detailed error output`;
  }

  async findLatestFailedTask(projectId: string, chatSessionId: string) {
    return this.prisma.agentTask.findFirst({
      where: this.buildSessionFailureFilter(projectId, chatSessionId),
      include: {
        agent: { select: { role: true } },
        issue: {
          select: {
            id: true,
            title: true,
            gitlabIid: true,
            chatSessionId: true,
          },
        },
        logs: {
          where: { level: { in: ['ERROR', 'WARN'] } },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
      orderBy: [{ completedAt: 'desc' }, { updatedAt: 'desc' }],
    });
  }

  async getLatestPipelineFailure(projectId: string, chatSessionId: string) {
    const failedTask = await this.findLatestFailedTask(
      projectId,
      chatSessionId,
    );
    if (!failedTask) return null;

    return {
      taskId: failedTask.id,
      taskType: failedTask.type,
      agentRole: failedTask.agent.role,
      issueId: failedTask.issueId,
      issueTitle: failedTask.issue?.title ?? null,
      issueGitlabIid: failedTask.issue?.gitlabIid ?? null,
      gitlabMrIid: failedTask.gitlabMrIid ?? null,
      failedAt: failedTask.completedAt ?? failedTask.updatedAt,
      reason: this.extractTaskFailureReason(failedTask),
    };
  }

  private async resolveMrIidForIssue(issueId: string): Promise<number | null> {
    const latest = await this.prisma.agentTask.findFirst({
      where: { issueId, gitlabMrIid: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { gitlabMrIid: true },
    });
    return latest?.gitlabMrIid ?? null;
  }

  normalizeFeedbackSource(value: unknown): FeedbackSource {
    const raw = typeof value === 'string' ? value : '';
    if (
      raw === 'review' ||
      raw === 'pipeline' ||
      raw === 'user' ||
      raw === 'functional-test' ||
      raw === 'ui-test' ||
      raw === 'security'
    ) {
      return raw;
    }
    return 'user';
  }

  async resumePipelineFromFailedTask(
    projectId: string,
    chatSessionId: string,
    failedTaskId?: string,
  ) {
    const session = await this.prisma.chatSession.findUnique({
      where: { id: chatSessionId },
      select: { id: true, projectId: true, title: true },
    });
    if (!session || session.projectId !== projectId) {
      throw new NotFoundException(
        `Session ${chatSessionId} not found for project ${projectId}`,
      );
    }

    const failedTask = failedTaskId
      ? await this.prisma.agentTask.findFirst({
          where: {
            id: failedTaskId,
            ...this.buildSessionFailureFilter(projectId, chatSessionId),
          },
          include: {
            agent: { select: { role: true } },
            issue: { select: { id: true, title: true, gitlabIid: true } },
            logs: {
              where: { level: { in: ['ERROR', 'WARN'] } },
              orderBy: { createdAt: 'desc' },
              take: 1,
            },
          },
        })
      : await this.findLatestFailedTask(projectId, chatSessionId);

    if (!failedTask) {
      throw new NotFoundException(
        'No failed pipeline task found for this session',
      );
    }

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { gitlabProjectId: true },
    });
    const gitlabProjectId = project?.gitlabProjectId;

    switch (failedTask.type) {
      case AgentTaskType.DESIGN_ARCHITECTURE:
        await this.flow.startArchitectDesign(projectId, chatSessionId);
        break;
      case AgentTaskType.ANALYZE_ISSUES:
        await this.flow.startArchitectGrounding(projectId, chatSessionId);
        break;
      case AgentTaskType.CREATE_ISSUES:
        await this.flow.startIssueCompilation(projectId, chatSessionId);
        break;
      case AgentTaskType.WRITE_CODE:
        await this.flow.startCoding(projectId, chatSessionId);
        break;
      case AgentTaskType.FIX_CODE: {
        if (!failedTask.issueId) {
          throw new NotFoundException('Cannot resume FIX_CODE without issueId');
        }
        const input =
          (failedTask.input as Record<string, unknown> | null) ?? {};
        const feedback =
          typeof input.feedback === 'string' && input.feedback.trim().length > 0
            ? input.feedback
            : `Retry failed fix attempt: ${this.extractTaskFailureReason(failedTask)}`;
        const feedbackSource = this.normalizeFeedbackSource(
          input.feedbackSource,
        );
        await this.retriggerCoder(
          projectId,
          chatSessionId,
          failedTask.issueId,
          feedback,
          feedbackSource,
        );
        break;
      }
      case AgentTaskType.REVIEW_CODE: {
        if (!failedTask.issueId)
          throw new NotFoundException(
            'Cannot resume REVIEW_CODE without issueId',
          );
        if (!gitlabProjectId)
          throw new NotFoundException('Project has no GitLab project ID');
        const mrIid =
          failedTask.gitlabMrIid ??
          (await this.resolveMrIidForIssue(failedTask.issueId));
        if (!mrIid)
          throw new NotFoundException(
            'Cannot resume REVIEW_CODE without MR IID',
          );
        await this.flow.startCodeReview(
          projectId,
          chatSessionId,
          failedTask.issueId,
          mrIid,
          gitlabProjectId,
        );
        break;
      }
      case AgentTaskType.TEST_FUNCTIONAL: {
        if (!failedTask.issueId)
          throw new NotFoundException(
            'Cannot resume TEST_FUNCTIONAL without issueId',
          );
        if (!gitlabProjectId)
          throw new NotFoundException('Project has no GitLab project ID');
        const mrIid =
          failedTask.gitlabMrIid ??
          (await this.resolveMrIidForIssue(failedTask.issueId));
        if (!mrIid)
          throw new NotFoundException(
            'Cannot resume TEST_FUNCTIONAL without MR IID',
          );
        await this.flow.startFunctionalTest(
          projectId,
          chatSessionId,
          failedTask.issueId,
          mrIid,
          gitlabProjectId,
        );
        break;
      }
      case AgentTaskType.TEST_UI: {
        if (!failedTask.issueId)
          throw new NotFoundException('Cannot resume TEST_UI without issueId');
        if (!gitlabProjectId)
          throw new NotFoundException('Project has no GitLab project ID');
        const mrIid =
          failedTask.gitlabMrIid ??
          (await this.resolveMrIidForIssue(failedTask.issueId));
        if (!mrIid)
          throw new NotFoundException('Cannot resume TEST_UI without MR IID');
        await this.flow.startUiTest(
          projectId,
          chatSessionId,
          failedTask.issueId,
          mrIid,
          gitlabProjectId,
        );
        break;
      }
      case AgentTaskType.TEST_SECURITY: {
        if (!failedTask.issueId)
          throw new NotFoundException(
            'Cannot resume TEST_SECURITY without issueId',
          );
        if (!gitlabProjectId)
          throw new NotFoundException('Project has no GitLab project ID');
        const mrIid =
          failedTask.gitlabMrIid ??
          (await this.resolveMrIidForIssue(failedTask.issueId));
        if (!mrIid)
          throw new NotFoundException(
            'Cannot resume TEST_SECURITY without MR IID',
          );
        await this.flow.startPenTest(
          projectId,
          chatSessionId,
          failedTask.issueId,
          mrIid,
          gitlabProjectId,
        );
        break;
      }
      case AgentTaskType.WRITE_DOCS: {
        if (!failedTask.issueId)
          throw new NotFoundException(
            'Cannot resume WRITE_DOCS without issueId',
          );
        if (!gitlabProjectId)
          throw new NotFoundException('Project has no GitLab project ID');
        const mrIid =
          failedTask.gitlabMrIid ??
          (await this.resolveMrIidForIssue(failedTask.issueId));
        if (!mrIid)
          throw new NotFoundException(
            'Cannot resume WRITE_DOCS without MR IID',
          );
        await this.flow.startDocumenter(
          projectId,
          chatSessionId,
          failedTask.issueId,
          mrIid,
          gitlabProjectId,
        );
        break;
      }
      case AgentTaskType.DEPLOY:
        await this.flow.startDevopsSetup(projectId, chatSessionId);
        break;
      case AgentTaskType.FEATURE_INTERVIEW:
        await this.flow.startFeatureInterview(
          projectId,
          chatSessionId,
          session.title || 'Feature Session',
        );
        break;
      default:
        throw new NotFoundException(
          `Resume is not supported for failed task type ${failedTask.type}`,
        );
    }

    const previousOutput =
      failedTask.output && typeof failedTask.output === 'object'
        ? (failedTask.output as Record<string, unknown>)
        : {};
    await this.prisma.agentTask.update({
      where: { id: failedTask.id },
      data: {
        status: AgentTaskStatus.CANCELLED,
        output: {
          ...previousOutput,
          resumed: true,
          resumedAt: new Date().toISOString(),
        } as any,
      },
    });

    const resumeMsg = await this.chatService.addMessage({
      chatSessionId,
      role: 'SYSTEM' as any,
      content: `▶️ Pipeline resumed from failed task ${failedTask.type} (${failedTask.id}).`,
    });
    this.chatGateway.emitToSession(chatSessionId, 'newMessage', resumeMsg);

    return {
      resumed: true,
      resumedFromTaskId: failedTask.id,
      resumedFromTaskType: failedTask.type,
    };
  }
}
