import {
  Controller,
  Post,
  Body,
  Headers,
  HttpCode,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiExcludeEndpoint } from '@nestjs/swagger';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../settings/system-settings.service';
import { Public } from '../common/decorators/public.decorator';
import { IssueStatus, CommentAuthorType } from '@prisma/client';

/** Maps GitLab issue state to our IssueStatus */
function mapGitLabState(state: string): IssueStatus {
  switch (state) {
    case 'opened':
      return IssueStatus.OPEN;
    case 'closed':
      return IssueStatus.CLOSED;
    default:
      return IssueStatus.OPEN;
  }
}

@ApiTags('gitlab')
@Controller('gitlab')
export class GitlabController {
  private readonly logger = new Logger(GitlabController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly systemSettings: SystemSettingsService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  @Public()
  @Post('webhook')
  @HttpCode(200)
  @ApiExcludeEndpoint()
  async handleWebhook(
    @Headers('x-gitlab-token') token: string,
    @Body() payload: any,
  ) {
    // Validate webhook token
    const webhookSecret = this.systemSettings.gitlabWebhookSecret;
    if (!webhookSecret || token !== webhookSecret) {
      throw new ForbiddenException('Invalid webhook token');
    }

    const eventType = payload.object_kind;
    this.logger.log(`Received GitLab webhook: ${eventType}`);

    switch (eventType) {
      case 'issue':
        await this.handleIssueEvent(payload);
        break;
      case 'note':
        await this.handleNoteEvent(payload);
        break;
      case 'pipeline':
        await this.handlePipelineEvent(payload);
        break;
      case 'merge_request':
        await this.handleMergeRequestEvent(payload);
        break;
      default:
        this.logger.debug(`Ignoring event type: ${eventType}`);
    }

    return { received: true };
  }

  private async handleIssueEvent(payload: any) {
    const { object_attributes: attrs, project } = payload;
    const gitlabProjectId = project.id as number;
    const gitlabIid = attrs.iid as number;

    // Find the local project by gitlabProjectId
    const localProject = await this.prisma.project.findFirst({
      where: { gitlabProjectId },
    });

    if (!localProject) {
      this.logger.warn(
        `No local project found for GitLab project ID ${gitlabProjectId}`,
      );
      return;
    }

    const action = attrs.action as string;
    this.logger.log(
      `Issue event: ${action} — #${gitlabIid} "${attrs.title}" in project ${localProject.slug}`,
    );

    // Upsert: create or update the local issue
    await this.prisma.issue.upsert({
      where: {
        projectId_gitlabIid: {
          projectId: localProject.id,
          gitlabIid,
        },
      },
      create: {
        projectId: localProject.id,
        gitlabIssueId: attrs.id,
        gitlabIid,
        title: attrs.title,
        description: attrs.description ?? null,
        status: mapGitLabState(attrs.state),
        labels: attrs.labels?.map((l: any) => l.title) ?? [],
      },
      update: {
        title: attrs.title,
        description: attrs.description ?? null,
        status: mapGitLabState(attrs.state),
        labels: attrs.labels?.map((l: any) => l.title) ?? [],
      },
    });
  }

  /**
   * Handle note (comment) events on issues.
   * Saves user comments to DB and emits gitlab.userComment event.
   * Skips notes from hub-bot to avoid loops.
   */
  private async handleNoteEvent(payload: any) {
    const { object_attributes: attrs, project, issue } = payload;

    // Only handle issue notes (not MR notes, snippets, etc.)
    if (attrs.noteable_type !== 'Issue' || !issue) {
      return;
    }

    // Skip bot-generated notes to avoid feedback loops
    const authorUsername = (payload.user?.username ?? '').toLowerCase();
    if (authorUsername === 'hub-bot') {
      this.logger.debug('Skipping hub-bot note');
      return;
    }

    const gitlabProjectId = project.id as number;
    const gitlabIid = issue.iid as number;

    const localProject = await this.prisma.project.findFirst({
      where: { gitlabProjectId },
    });
    if (!localProject) return;

    const localIssue = await this.prisma.issue.findFirst({
      where: { projectId: localProject.id, gitlabIid },
    });
    if (!localIssue) {
      this.logger.warn(`No local issue for GitLab issue #${gitlabIid} in project ${localProject.slug}`);
      return;
    }

    this.logger.log(
      `Note event: ${authorUsername} commented on #${gitlabIid} in ${localProject.slug}`,
    );

    // Save the comment to DB
    await this.prisma.issueComment.create({
      data: {
        issueId: localIssue.id,
        gitlabNoteId: attrs.id,
        authorType: CommentAuthorType.USER,
        authorName: payload.user?.name ?? authorUsername,
        content: attrs.note ?? attrs.body ?? '',
      },
    });

    // Emit event for agent orchestrator
    this.eventEmitter.emit('gitlab.userComment', {
      projectId: localProject.id,
      issueId: localIssue.id,
      gitlabIid,
      issueStatus: localIssue.status,
      authorName: payload.user?.name ?? authorUsername,
      content: attrs.note ?? attrs.body ?? '',
    });
  }

  /**
   * Handle pipeline events.
   * Emits gitlab.pipelineResult for failed/success pipelines.
   */
  private async handlePipelineEvent(payload: any) {
    const { object_attributes: attrs, project } = payload;
    const status = attrs.status as string;
    const ref = attrs.ref as string;
    const pipelineId = attrs.id as number;
    const gitlabProjectId = project.id as number;

    // Only care about terminal states
    if (status !== 'success' && status !== 'failed') {
      this.logger.debug(`Pipeline ${pipelineId}: status=${status} — ignoring non-terminal state`);
      return;
    }

    const localProject = await this.prisma.project.findFirst({
      where: { gitlabProjectId },
    });
    if (!localProject) return;

    this.logger.log(
      `Pipeline event: ${status} for ref "${ref}" (pipeline ${pipelineId}) in ${localProject.slug}`,
    );

    this.eventEmitter.emit('gitlab.pipelineResult', {
      projectId: localProject.id,
      gitlabProjectId,
      pipelineId,
      ref,
      status,
    });
  }

  /**
   * Handle merge request events.
   * Currently only logs — future use for MR-based workflows.
   */
  private async handleMergeRequestEvent(payload: any) {
    const { object_attributes: attrs, project } = payload;
    this.logger.log(
      `MR event: ${attrs.action} — !${attrs.iid} "${attrs.title}" in project ${project.id}`,
    );
  }
}
