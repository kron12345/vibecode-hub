/**
 * GitLab Core — Base class with constructor, HTTP helpers, error handling,
 * plus project CRUD, branches, repository, members, webhooks, and file uploads.
 */
import { Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import FormData = require('form-data');
import { SystemSettingsService } from '../settings/system-settings.service';
import {
  GitLabProject,
  GitLabBranch,
  GitLabTreeItem,
  CreateProjectOptions,
} from './gitlab.interfaces';

export class GitlabCoreService {
  protected readonly logger = new Logger('GitlabService');

  constructor(
    protected readonly httpService: HttpService,
    protected readonly systemSettings: SystemSettingsService,
  ) {}

  // ─── HTTP Helpers ─────────────────────────────────────────

  protected get apiUrl(): string {
    return `${this.systemSettings.gitlabUrl}/api/v4`;
  }

  protected get headers() {
    return { 'PRIVATE-TOKEN': this.systemSettings.gitlabToken };
  }

  /** Execute a GraphQL query against the GitLab API */
  protected async graphql<T = any>(
    query: string,
    variables?: Record<string, any>,
  ): Promise<T> {
    const url = `${this.systemSettings.gitlabUrl}/api/graphql`;
    const response = await firstValueFrom(
      this.httpService.post(
        url,
        { query, variables },
        { headers: this.headers },
      ),
    );
    if (response.data.errors?.length) {
      throw new Error(`GitLab GraphQL: ${response.data.errors[0].message}`);
    }
    return response.data.data;
  }

  // ─── Projects ─────────────────────────────────────────────

  async createProject(options: CreateProjectOptions): Promise<GitLabProject> {
    try {
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
      this.logger.log(
        `Created GitLab project: ${data.path_with_namespace} (ID: ${data.id})`,
      );
      return data;
    } catch (err: any) {
      const detail = err.response?.data
        ? JSON.stringify(err.response.data)
        : err.message;
      this.logger.error(
        `GitLab createProject failed (${options.path}): ${detail}`,
      );
      throw new Error(`GitLab createProject failed: ${detail}`);
    }
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
      this.httpService.delete(`${this.apiUrl}/projects/${projectId}`, {
        headers: this.headers,
      }),
    );
    this.logger.log(`Deleted GitLab project ID: ${projectId}`);
  }

  // ─── Branches ─────────────────────────────────────────────

  async createBranch(
    projectId: number,
    name: string,
    ref: string,
  ): Promise<GitLabBranch> {
    const { data } = await firstValueFrom(
      this.httpService.post<GitLabBranch>(
        `${this.apiUrl}/projects/${projectId}/repository/branches`,
        { branch: name, ref },
        { headers: this.headers },
      ),
    );
    this.logger.log(
      `Created branch "${name}" from "${ref}" in project ${projectId}`,
    );
    return data;
  }

  async deleteBranch(projectId: number, name: string): Promise<void> {
    await firstValueFrom(
      this.httpService.delete(
        `${this.apiUrl}/projects/${projectId}/repository/branches/${encodeURIComponent(name)}`,
        { headers: this.headers },
      ),
    );
    this.logger.log(`Deleted branch "${name}" in project ${projectId}`);
  }

  // ─── Repository ───────────────────────────────────────────

  async getRepositoryTree(
    projectId: number,
    ref: string,
    path?: string,
  ): Promise<GitLabTreeItem[]> {
    const params: Record<string, any> = {
      ref,
      per_page: 100,
      recursive: false,
    };
    if (path) params.path = path;

    const { data } = await firstValueFrom(
      this.httpService.get<GitLabTreeItem[]>(
        `${this.apiUrl}/projects/${projectId}/repository/tree`,
        { headers: this.headers, params },
      ),
    );
    return data;
  }

  // ─── Members ──────────────────────────────────────────────

  /**
   * Add a user as member to a GitLab project.
   * access_level: 10=Guest, 20=Reporter, 30=Developer, 40=Maintainer, 50=Owner
   */
  async addProjectMember(
    projectId: number,
    userId: number,
    accessLevel: number = 40,
  ): Promise<void> {
    try {
      await firstValueFrom(
        this.httpService.post(
          `${this.apiUrl}/projects/${projectId}/members`,
          { user_id: userId, access_level: accessLevel },
          { headers: this.headers },
        ),
      );
      this.logger.log(
        `Added user ${userId} as member (level ${accessLevel}) to project ${projectId}`,
      );
    } catch (err: any) {
      // 409 = already a member — that's fine
      if (err?.response?.status === 409) {
        this.logger.debug(
          `User ${userId} already member of project ${projectId}`,
        );
        return;
      }
      throw err;
    }
  }

  // ─── File Uploads ─────────────────────────────────────────

  /**
   * Upload a file to a GitLab project. Returns the markdown link and full URL.
   * Uses POST /projects/:id/uploads (multipart/form-data).
   */
  async uploadProjectFile(
    projectId: number,
    fileName: string,
    fileBuffer: Buffer,
    contentType = 'application/octet-stream',
  ): Promise<{ markdown: string; url: string; fullPath: string }> {
    const form = new FormData();
    form.append('file', fileBuffer, { filename: fileName, contentType });

    const { data } = await firstValueFrom(
      this.httpService.post(
        `${this.apiUrl}/projects/${projectId}/uploads`,
        form,
        {
          headers: {
            ...this.headers,
            ...form.getHeaders(),
          },
        },
      ),
    );

    this.logger.log(
      `Uploaded file "${fileName}" to project ${projectId}: ${data.markdown}`,
    );
    return {
      markdown: data.markdown,
      url: data.url,
      fullPath: data.full_path,
    };
  }

  /**
   * Upload a file as wiki attachment. Returns markdown link and URL.
   * Uses POST /projects/:id/wikis/attachments (multipart/form-data).
   * Falls back to regular project upload if wiki attachment endpoint is unavailable.
   */
  async uploadWikiAttachment(
    projectId: number,
    fileName: string,
    fileBuffer: Buffer,
    contentType = 'image/png',
  ): Promise<{ markdown: string; url: string }> {
    const form = new FormData();
    form.append('file', fileBuffer, { filename: fileName, contentType });

    try {
      const { data } = await firstValueFrom(
        this.httpService.post(
          `${this.apiUrl}/projects/${projectId}/wikis/attachments`,
          form,
          {
            headers: {
              ...this.headers,
              ...form.getHeaders(),
            },
          },
        ),
      );
      this.logger.log(
        `Uploaded wiki attachment "${fileName}" to project ${projectId}`,
      );
      return {
        markdown: data.link?.markdown ?? data.markdown,
        url: data.link?.url ?? data.url,
      };
    } catch {
      // Fallback to regular project upload
      const result = await this.uploadProjectFile(
        projectId,
        fileName,
        fileBuffer,
        contentType,
      );
      return { markdown: result.markdown, url: result.url };
    }
  }

  // ─── Webhooks ─────────────────────────────────────────────

  async addWebhook(
    projectId: number,
    url: string,
    secretToken: string,
  ): Promise<void> {
    await firstValueFrom(
      this.httpService.post(
        `${this.apiUrl}/projects/${projectId}/hooks`,
        {
          url,
          token: secretToken,
          issues_events: true,
          merge_requests_events: true,
          note_events: true,
          pipeline_events: true,
          push_events: false,
          enable_ssl_verification: true,
        },
        { headers: this.headers },
      ),
    );
    this.logger.log(`Added webhook to GitLab project ${projectId}`);
  }
}
