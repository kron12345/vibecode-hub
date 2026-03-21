import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../settings/system-settings.service';
import { ChatService } from '../chat/chat.service';
import { ChatGateway } from '../chat/chat.gateway';
import { AgentTaskStatus, AgentStatus, IssueStatus, MessageRole } from '@prisma/client';

/** Default: tasks with no activity for > 30 minutes are considered stuck */
const DEFAULT_INACTIVITY_TIMEOUT_MINUTES = 30;

@Injectable()
export class PipelineCleanupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PipelineCleanupService.name);
  private stuckCheckTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SystemSettingsService,
    private readonly chatService: ChatService,
    private readonly chatGateway: ChatGateway,
  ) {}

  async onModuleInit() {
    await this.cleanupZombieTasks();

    const pipelineCfg = this.settings.getPipelineConfig();
    const intervalMs = (pipelineCfg.stuckCheckIntervalMinutes ?? 5) * 60 * 1000;
    this.stuckCheckTimer = setInterval(() => {
      this.cleanupStuckTasks().catch((err) => {
        this.logger.error(`Stuck task cleanup failed: ${err.message}`);
      });
    }, intervalMs);
    this.logger.log(
      `Stuck task cleanup scheduled (every ${pipelineCfg.stuckCheckIntervalMinutes ?? 5} min)`,
    );
  }

  async onModuleDestroy() {
    if (this.stuckCheckTimer) {
      clearInterval(this.stuckCheckTimer);
      this.stuckCheckTimer = null;
    }

    try {
      const result = await this.prisma.agentTask.updateMany({
        where: { status: AgentTaskStatus.RUNNING },
        data: { status: AgentTaskStatus.COMPLETED, completedAt: new Date() },
      });
      if (result.count > 0) {
        this.logger.warn(
          `Marked ${result.count} running task(s) as COMPLETED during shutdown`,
        );
      }
    } catch (err) {
      this.logger.error(`Shutdown task cleanup failed: ${err.message}`);
    }
  }

  async pausePipelineForSessionFailure(
    projectId: string,
    chatSessionId: string,
    issueId: string,
    reason: string,
  ): Promise<void> {
    const session = await this.prisma.chatSession.findUnique({
      where: { id: chatSessionId },
      select: { id: true, projectId: true },
    });
    if (!session || session.projectId !== projectId) return;

    const truncatedReason =
      reason.length > 1500 ? `${reason.substring(0, 1500)}…` : reason;
    const msg = await this.chatService.addMessage({
      chatSessionId,
      role: MessageRole.SYSTEM,
      content:
        `⛔ Pipeline paused for this session.\n\n` +
        `Issue: ${issueId}\n` +
        `Reason: ${truncatedReason}\n\n` +
        `Fix the provider/tool problem, then resume from the latest failed task.`,
    });

    this.chatGateway.emitToSession(chatSessionId, 'newMessage', msg);
    this.chatGateway.emitToSession(chatSessionId, 'chatSuggestions', {
      chatSessionId,
      suggestions: ['▶️ Resume pipeline', '🛠️ Fix provider/tool issue'],
    });
  }

  /**
   * On startup, mark all RUNNING tasks as COMPLETED.
   * After a restart, no backing CLI process exists — these are zombies.
   */
  private async cleanupZombieTasks(): Promise<void> {
    const zombies = await this.prisma.agentTask.findMany({
      where: { status: AgentTaskStatus.RUNNING },
      select: { id: true, type: true },
    });

    if (zombies.length === 0) return;

    this.logger.warn(
      `Found ${zombies.length} zombie task(s) from previous process — marking as COMPLETED`,
    );

    await this.prisma.agentTask.updateMany({
      where: { status: AgentTaskStatus.RUNNING },
      data: {
        status: AgentTaskStatus.COMPLETED,
        completedAt: new Date(),
      },
    });

    const zombieIssueIds = (
      await this.prisma.agentTask.findMany({
        where: { id: { in: zombies.map((z) => z.id) } },
        select: { issueId: true },
      })
    )
      .map((t) => t.issueId)
      .filter((id): id is string => !!id);

    if (zombieIssueIds.length > 0) {
      await this.prisma.issue.updateMany({
        where: {
          id: { in: zombieIssueIds },
          status: {
            in: [
              IssueStatus.IN_PROGRESS,
              IssueStatus.IN_REVIEW,
              IssueStatus.TESTING,
            ],
          },
        },
        data: { status: IssueStatus.OPEN },
      });
    }
  }

  async cleanupStuckTasks(): Promise<void> {
    const inactivityMinutes =
      parseInt(
        this.settings.get(
          'pipeline.stuckTimeoutMinutes',
          '',
          String(DEFAULT_INACTIVITY_TIMEOUT_MINUTES),
        ),
        10,
      ) || DEFAULT_INACTIVITY_TIMEOUT_MINUTES;

    const cutoff = new Date(Date.now() - inactivityMinutes * 60 * 1000);

    const candidates = await this.prisma.agentTask.findMany({
      where: {
        status: AgentTaskStatus.RUNNING,
        startedAt: { lt: cutoff },
      },
      include: {
        agent: { select: { id: true, role: true, projectId: true } },
        issue: {
          select: {
            id: true,
            title: true,
            gitlabIid: true,
            status: true,
            chatSessionId: true,
          },
        },
      },
    });

    if (candidates.length === 0) return;

    const stuckTasks: typeof candidates = [];

    for (const task of candidates) {
      const recentLog = await this.prisma.agentLog.findFirst({
        where: {
          agentTaskId: task.id,
          createdAt: { gt: cutoff },
        },
        orderBy: { createdAt: 'desc' },
      });

      if (recentLog) continue;

      const recentMessage = await this.prisma.chatMessage.findFirst({
        where: {
          agentTaskId: task.id,
          createdAt: { gt: cutoff },
        },
        orderBy: { createdAt: 'desc' },
      });

      if (recentMessage) continue;

      stuckTasks.push(task);
    }

    if (stuckTasks.length === 0) return;

    this.logger.warn(
      `Found ${stuckTasks.length} stuck task(s) (no activity for ${inactivityMinutes}+ min) ` +
        `out of ${candidates.length} long-running candidate(s)`,
    );

    for (const task of stuckTasks) {
      try {
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

        const fallbackSession = !task.issue?.chatSessionId
          ? await this.prisma.chatMessage.findFirst({
              where: { agentTaskId: task.id },
              orderBy: { createdAt: 'desc' },
              select: { chatSessionId: true },
            })
          : null;
        const failureSessionId =
          task.issue?.chatSessionId ?? fallbackSession?.chatSessionId;
        if (failureSessionId) {
          await this.pausePipelineForSessionFailure(
            task.agent.projectId,
            failureSessionId,
            task.issue?.id ?? 'n/a',
            `Task ${task.type} was marked FAILED after ${inactivityMinutes}+ minutes without activity.`,
          );
        }
      } catch (err) {
        this.logger.error(
          `Failed to cleanup stuck task ${task.id}: ${err.message}`,
        );
      }
    }

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
      this.logger.warn(
        `Reset orphaned agent ${agent.id} (${agent.role}) from ${agent.status} to IDLE`,
      );
    }
  }
}
