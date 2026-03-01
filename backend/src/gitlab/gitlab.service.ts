import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { SystemSettingsService } from '../settings/system-settings.service';

export interface GitLabProject {
  id: number;
  name: string;
  path: string;
  path_with_namespace: string;
  web_url: string;
  default_branch: string;
}

export interface GitLabIssue {
  id: number;
  iid: number;
  title: string;
  description: string | null;
  state: 'opened' | 'closed';
  labels: string[];
  web_url: string;
  created_at: string;
  updated_at: string;
}

interface CreateProjectOptions {
  name: string;
  path: string;
  description?: string;
  initializeWithReadme?: boolean;
}

interface CreateIssueOptions {
  title: string;
  description?: string;
  labels?: string[];
}

interface UpdateIssueOptions {
  title?: string;
  description?: string;
  labels?: string[];
  state_event?: 'close' | 'reopen';
}

@Injectable()
export class GitlabService {
  private readonly logger = new Logger(GitlabService.name);

  constructor(
    private readonly httpService: HttpService,
    private readonly systemSettings: SystemSettingsService,
  ) {}

  private get apiUrl(): string {
    return `${this.systemSettings.gitlabUrl}/api/v4`;
  }

  private get headers() {
    return { 'PRIVATE-TOKEN': this.systemSettings.gitlabToken };
  }

  // ─── Projects ────────────────────────────────────────────────

  async createProject(options: CreateProjectOptions): Promise<GitLabProject> {
    const { data } = await firstValueFrom(
      this.httpService.post<GitLabProject>(
        `${this.apiUrl}/projects`,
        {
          name: options.name,
          path: options.path,
          description: options.description ?? '',
          initialize_with_readme: options.initializeWithReadme ?? true,
          visibility: 'private',
        },
        { headers: this.headers },
      ),
    );
    this.logger.log(`Created GitLab project: ${data.path_with_namespace} (ID: ${data.id})`);
    return data;
  }

  async getProject(projectId: number): Promise<GitLabProject> {
    const { data } = await firstValueFrom(
      this.httpService.get<GitLabProject>(
        `${this.apiUrl}/projects/${projectId}`,
        { headers: this.headers },
      ),
    );
    return data;
  }

  async deleteProject(projectId: number): Promise<void> {
    await firstValueFrom(
      this.httpService.delete(
        `${this.apiUrl}/projects/${projectId}`,
        { headers: this.headers },
      ),
    );
    this.logger.log(`Deleted GitLab project ID: ${projectId}`);
  }

  // ─── Issues ──────────────────────────────────────────────────

  async createIssue(projectId: number, options: CreateIssueOptions): Promise<GitLabIssue> {
    const { data } = await firstValueFrom(
      this.httpService.post<GitLabIssue>(
        `${this.apiUrl}/projects/${projectId}/issues`,
        {
          title: options.title,
          description: options.description ?? '',
          labels: options.labels?.join(',') ?? '',
        },
        { headers: this.headers },
      ),
    );
    this.logger.log(`Created GitLab issue #${data.iid} in project ${projectId}`);
    return data;
  }

  async getIssues(projectId: number, state?: 'opened' | 'closed' | 'all'): Promise<GitLabIssue[]> {
    const { data } = await firstValueFrom(
      this.httpService.get<GitLabIssue[]>(
        `${this.apiUrl}/projects/${projectId}/issues`,
        {
          headers: this.headers,
          params: {
            state: state ?? 'opened',
            per_page: 100,
            order_by: 'created_at',
            sort: 'desc',
          },
        },
      ),
    );
    return data;
  }

  async getIssue(projectId: number, issueIid: number): Promise<GitLabIssue> {
    const { data } = await firstValueFrom(
      this.httpService.get<GitLabIssue>(
        `${this.apiUrl}/projects/${projectId}/issues/${issueIid}`,
        { headers: this.headers },
      ),
    );
    return data;
  }

  async updateIssue(
    projectId: number,
    issueIid: number,
    options: UpdateIssueOptions,
  ): Promise<GitLabIssue> {
    const body: Record<string, unknown> = {};
    if (options.title !== undefined) body.title = options.title;
    if (options.description !== undefined) body.description = options.description;
    if (options.labels !== undefined) body.labels = options.labels.join(',');
    if (options.state_event !== undefined) body.state_event = options.state_event;

    const { data } = await firstValueFrom(
      this.httpService.put<GitLabIssue>(
        `${this.apiUrl}/projects/${projectId}/issues/${issueIid}`,
        body,
        { headers: this.headers },
      ),
    );
    this.logger.log(`Updated GitLab issue #${issueIid} in project ${projectId}`);
    return data;
  }

  async closeIssue(projectId: number, issueIid: number): Promise<GitLabIssue> {
    return this.updateIssue(projectId, issueIid, { state_event: 'close' });
  }

  // ─── Webhooks ────────────────────────────────────────────────

  async addWebhook(projectId: number, url: string, secretToken: string): Promise<void> {
    await firstValueFrom(
      this.httpService.post(
        `${this.apiUrl}/projects/${projectId}/hooks`,
        {
          url,
          token: secretToken,
          issues_events: true,
          merge_requests_events: true,
          push_events: false,
          enable_ssl_verification: true,
        },
        { headers: this.headers },
      ),
    );
    this.logger.log(`Added webhook to GitLab project ${projectId}`);
  }
}
