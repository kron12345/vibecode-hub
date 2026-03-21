import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { HardwareService } from './hardware.service';
import { PrismaService } from '../prisma/prisma.service';

@ApiTags('monitor')
@Controller('monitor')
export class MonitorController {
  constructor(
    private readonly hardwareService: HardwareService,
    private readonly prisma: PrismaService,
  ) {}

  /** Current hardware snapshot */
  @Public()
  @Get('hardware')
  getHardware() {
    return (
      this.hardwareService.getLatest() ?? {
        gpus: [],
        cpu: { temp: 0, load1: 0, load5: 0, load15: 0 },
        ram: { totalMb: 0, usedMb: 0, availableMb: 0, usedPercent: 0 },
        timestamp: Date.now(),
      }
    );
  }

  /** Hardware history for sparkline charts */
  @Public()
  @Get('hardware/history')
  getHardwareHistory() {
    return this.hardwareService.getHistory();
  }

  /** Agent log history with filters */
  @Get('logs')
  async getLogs(
    @Query('projectId') projectId?: string,
    @Query('agentRole') agentRole?: string,
    @Query('level') level?: string,
    @Query('limit') limit = '50',
    @Query('offset') offset = '0',
  ) {
    const take = Math.min(parseInt(limit) || 50, 200);
    const skip = parseInt(offset) || 0;

    const where: any = {};

    if (level) {
      where.level = level;
    }

    // Filter by project or agent role through relations
    if (projectId || agentRole) {
      where.agentTask = {
        agent: {
          ...(projectId && { projectId }),
          ...(agentRole && { role: agentRole }),
        },
      };
    }

    const [logs, total] = await Promise.all([
      this.prisma.agentLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        skip,
        include: {
          agentTask: {
            select: {
              id: true,
              type: true,
              status: true,
              issueId: true,
              agent: {
                select: {
                  id: true,
                  role: true,
                  projectId: true,
                  project: { select: { id: true, name: true, slug: true } },
                },
              },
            },
          },
        },
      }),
      this.prisma.agentLog.count({ where }),
    ]);

    return { logs, total, limit: take, offset: skip };
  }

  /** Unified activity timeline — combines agent logs, agent messages, agent comments */
  @Get('activity')
  async getActivity(
    @Query('projectId') projectId?: string,
    @Query('limit') limit = '50',
    @Query('offset') offset = '0',
  ) {
    const take = Math.min(parseInt(limit) || 50, 100);
    const skip = parseInt(offset) || 0;

    // Fetch agent logs
    const logWhere: any = {};
    if (projectId) {
      logWhere.agentTask = { agent: { projectId } };
    }

    const [logs, comments, chatMessages] = await Promise.all([
      this.prisma.agentLog.findMany({
        where: { ...logWhere, level: { in: ['INFO', 'WARN', 'ERROR'] } },
        orderBy: { createdAt: 'desc' },
        take: take * 2,
        include: {
          agentTask: {
            select: {
              type: true,
              agent: {
                select: {
                  role: true,
                  projectId: true,
                  project: { select: { name: true, slug: true } },
                },
              },
            },
          },
        },
      }),

      // Agent comments on issues
      this.prisma.issueComment.findMany({
        where: {
          authorType: 'AGENT',
          ...(projectId && { issue: { projectId } }),
        },
        orderBy: { createdAt: 'desc' },
        take: take * 2,
        include: {
          issue: {
            select: {
              id: true,
              title: true,
              projectId: true,
              project: { select: { name: true, slug: true } },
            },
          },
          agentTask: {
            select: { agent: { select: { role: true } } },
          },
        },
      }),

      // Agent chat messages
      this.prisma.chatMessage.findMany({
        where: {
          role: 'AGENT',
          ...(projectId && {
            chatSession: { projectId },
          }),
        },
        orderBy: { createdAt: 'desc' },
        take: take * 2,
        select: {
          id: true,
          content: true,
          createdAt: true,
          chatSession: {
            select: {
              projectId: true,
              project: { select: { name: true, slug: true } },
            },
          },
          agentTask: {
            select: { type: true, agent: { select: { role: true } } },
          },
        },
      }),
    ]);

    // Merge into unified timeline
    const timeline = [
      ...logs.map((l) => ({
        type: 'log' as const,
        id: l.id,
        level: l.level,
        message: l.message,
        agentRole: l.agentTask?.agent?.role,
        projectName: l.agentTask?.agent?.project?.name,
        projectSlug: l.agentTask?.agent?.project?.slug,
        projectId: l.agentTask?.agent?.projectId,
        taskType: l.agentTask?.type,
        createdAt: l.createdAt,
      })),
      ...comments.map((c) => ({
        type: 'comment' as const,
        id: c.id,
        message:
          c.content.substring(0, 200) + (c.content.length > 200 ? '...' : ''),
        agentRole: c.agentTask?.agent?.role,
        projectName: c.issue?.project?.name,
        projectSlug: c.issue?.project?.slug,
        projectId: c.issue?.projectId,
        issueTitle: c.issue?.title,
        createdAt: c.createdAt,
      })),
      ...chatMessages.map((m) => ({
        type: 'message' as const,
        id: m.id,
        message:
          m.content.substring(0, 200) + (m.content.length > 200 ? '...' : ''),
        agentRole: m.agentTask?.agent?.role,
        projectName: m.chatSession?.project?.name,
        projectSlug: m.chatSession?.project?.slug,
        projectId: m.chatSession?.projectId,
        createdAt: m.createdAt,
      })),
    ];

    // Sort by time DESC, paginate
    timeline.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

    return {
      items: timeline.slice(skip, skip + take),
      total: timeline.length,
      limit: take,
      offset: skip,
    };
  }

  /** Aggregated agent overview — stats per role */
  @Get('agents/overview')
  async getAgentsOverview() {
    const instances = await this.prisma.agentInstance.findMany({
      include: {
        project: { select: { id: true, name: true, slug: true } },
        tasks: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            id: true,
            type: true,
            status: true,
            startedAt: true,
            completedAt: true,
            issue: { select: { id: true, title: true } },
          },
        },
        _count: { select: { tasks: true } },
      },
    });

    // Group by role
    const roleMap = new Map<
      string,
      {
        role: string;
        status: string;
        activeProjects: Array<{ id: string; name: string; slug: string }>;
        currentTask: any;
        totalTasks: number;
      }
    >();

    for (const inst of instances) {
      const existing = roleMap.get(inst.role);
      const isActive = inst.status === 'WORKING';
      const task = inst.tasks[0] ?? null;

      if (!existing) {
        roleMap.set(inst.role, {
          role: inst.role,
          status: inst.status,
          activeProjects: isActive
            ? [
                {
                  id: inst.project.id,
                  name: inst.project.name,
                  slug: inst.project.slug,
                },
              ]
            : [],
          currentTask: isActive ? task : null,
          totalTasks: inst._count.tasks,
        });
      } else {
        existing.totalTasks += inst._count.tasks;
        if (isActive) {
          existing.status = 'WORKING';
          existing.activeProjects.push({
            id: inst.project.id,
            name: inst.project.name,
            slug: inst.project.slug,
          });
          existing.currentTask = task;
        }
      }
    }

    // Compute task stats per role
    const taskStats = await this.prisma.agentTask.groupBy({
      by: ['status'],
      _count: true,
    });

    return {
      roles: Array.from(roleMap.values()),
      taskStats: taskStats.reduce(
        (acc, s) => ({ ...acc, [s.status]: s._count }),
        {},
      ),
    };
  }
}
