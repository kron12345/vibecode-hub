import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GitlabService } from '../gitlab/gitlab.service';
import { CreateIssueDto, UpdateIssueDto, CreateIssueCommentDto } from './issues.dto';
import { IssueStatus, CommentAuthorType } from '@prisma/client';

@Injectable()
export class IssuesService {
  private readonly logger = new Logger(IssuesService.name);

  constructor(
    private prisma: PrismaService,
    private gitlab: GitlabService,
  ) {}

  async findMilestonesByProject(projectId: string) {
    return this.prisma.milestone.findMany({
      where: { projectId },
      include: {
        issues: {
          where: { parentId: null },
          orderBy: { createdAt: 'asc' },
          select: { id: true, title: true, status: true, priority: true },
        },
      },
      orderBy: { sortOrder: 'asc' },
    });
  }

  async findByProject(projectId: string) {
    return this.prisma.issue.findMany({
      where: { projectId, parentId: null },
      include: {
        subIssues: { orderBy: { createdAt: 'asc' } },
        assignedAgent: { select: { id: true, role: true, status: true } },
        milestone: { select: { id: true, title: true, sortOrder: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findById(id: string) {
    const issue = await this.prisma.issue.findUnique({
      where: { id },
      include: {
        subIssues: {
          include: {
            assignedAgent: { select: { id: true, role: true, status: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
        assignedAgent: { select: { id: true, role: true, status: true } },
        project: { select: { id: true, slug: true, gitlabProjectId: true } },
      },
    });
    if (!issue) throw new NotFoundException(`Issue "${id}" not found`);
    return issue;
  }

  async create(dto: CreateIssueDto) {
    const { syncToGitlab, gitlabMilestoneId, ...data } = dto;

    const issue = await this.prisma.issue.create({
      data: {
        projectId: data.projectId,
        title: data.title,
        description: data.description,
        priority: data.priority,
        labels: data.labels ?? [],
        parentId: data.parentId,
        milestoneId: data.milestoneId,
      },
      include: { project: { select: { gitlabProjectId: true } } },
    });

    // Sync to GitLab if requested and project has a GitLab repo
    if (syncToGitlab && issue.project.gitlabProjectId) {
      try {
        const glIssue = await this.gitlab.createIssue(
          issue.project.gitlabProjectId,
          {
            title: issue.title,
            description: issue.description ?? undefined,
            labels: issue.labels,
            milestone_id: gitlabMilestoneId,
          },
        );
        const updated = await this.prisma.issue.update({
          where: { id: issue.id },
          data: {
            gitlabIssueId: glIssue.id,
            gitlabIid: glIssue.iid,
          },
        });
        // Return the updated issue so callers see the gitlabIid
        issue.gitlabIssueId = updated.gitlabIssueId;
        issue.gitlabIid = updated.gitlabIid;
        this.logger.log(`Synced issue to GitLab: #${glIssue.iid}`);
      } catch (err) {
        this.logger.warn(`Could not sync issue to GitLab: ${err.message}`);
      }
    }

    return issue;
  }

  async update(id: string, dto: UpdateIssueDto) {
    const issue = await this.prisma.issue.update({
      where: { id },
      data: dto,
      include: { project: { select: { gitlabProjectId: true } } },
    });

    // Sync status changes to GitLab
    if (issue.gitlabIid && issue.project.gitlabProjectId) {
      try {
        const updatePayload: Record<string, any> = {};
        if (dto.title) updatePayload.title = dto.title;
        if (dto.description !== undefined) updatePayload.description = dto.description;
        if (dto.labels) updatePayload.labels = dto.labels;
        if (dto.status === IssueStatus.CLOSED || dto.status === IssueStatus.DONE) {
          updatePayload.state_event = 'close';
        } else if (dto.status === IssueStatus.OPEN) {
          updatePayload.state_event = 'reopen';
        }

        if (Object.keys(updatePayload).length > 0) {
          await this.gitlab.updateIssue(
            issue.project.gitlabProjectId,
            issue.gitlabIid,
            updatePayload,
          );
        }
      } catch (err) {
        this.logger.warn(`Could not sync issue update to GitLab: ${err.message}`);
      }
    }

    return issue;
  }

  async delete(id: string) {
    return this.prisma.issue.delete({ where: { id } });
  }

  // ─── Comments ──────────────────────────────────────────────

  async getComments(issueId: string) {
    return this.prisma.issueComment.findMany({
      where: { issueId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async addComment(issueId: string, dto: CreateIssueCommentDto, userId?: string) {
    const issue = await this.prisma.issue.findUnique({
      where: { id: issueId },
      include: { project: { select: { gitlabProjectId: true } } },
    });
    if (!issue) throw new NotFoundException(`Issue "${issueId}" not found`);

    const authorName = dto.authorName ?? userId ?? 'Unknown';
    const authorType = dto.authorType ?? CommentAuthorType.USER;

    let gitlabNoteId: number | null = null;

    // Sync to GitLab if requested
    if (dto.syncToGitlab && issue.gitlabIid && issue.project.gitlabProjectId) {
      try {
        const note = await this.gitlab.createIssueNote(
          issue.project.gitlabProjectId,
          issue.gitlabIid,
          dto.content,
        );
        gitlabNoteId = note.id;
      } catch (err) {
        this.logger.warn(`Could not sync comment to GitLab: ${err.message}`);
      }
    }

    return this.prisma.issueComment.create({
      data: {
        issueId,
        authorType,
        authorName,
        content: dto.content,
        gitlabNoteId,
      },
    });
  }
}
