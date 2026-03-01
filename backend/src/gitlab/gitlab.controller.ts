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
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../settings/system-settings.service';
import { Public } from '../common/decorators/public.decorator';
import { IssueStatus } from '@prisma/client';

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
}
