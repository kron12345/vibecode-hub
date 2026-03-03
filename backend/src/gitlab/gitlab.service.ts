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

export interface GitLabWorkItem {
  id: string;       // "gid://gitlab/WorkItem/123"
  iid: string;      // Project-scoped IID
  title: string;
  state: string;
  workItemType: { name: string };
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

  // ─── Work Items (GraphQL) ────────────────────────────────────

  /** Execute a GraphQL query against the GitLab API */
  private async graphql<T = any>(query: string, variables?: Record<string, any>): Promise<T> {
    const url = `${this.systemSettings.gitlabUrl}/api/graphql`;
    const response = await firstValueFrom(
      this.httpService.post(url, { query, variables }, { headers: this.headers }),
    );
    if (response.data.errors?.length) {
      throw new Error(`GitLab GraphQL: ${response.data.errors[0].message}`);
    }
    return response.data.data;
  }

  /**
   * Get the WorkItem global ID for an Issue.
   * Needed as parentId when creating child Tasks.
   */
  async getWorkItemId(projectPath: string, issueIid: number): Promise<string> {
    const data = await this.graphql<{
      project: { issue: { id: string } };
    }>(
      `query($path: ID!, $iid: String!) {
        project(fullPath: $path) {
          issue(iid: $iid) { id }
        }
      }`,
      { path: projectPath, iid: String(issueIid) },
    );

    if (!data.project?.issue?.id) {
      throw new Error(`WorkItem ID not found for issue #${issueIid} in ${projectPath}`);
    }

    return data.project.issue.id;
  }

  /**
   * Create a Task work item as child of an Issue.
   * Uses GitLab's WorkItem GraphQL API with hierarchyWidget.
   * Task type ID = "gid://gitlab/WorkItems::Type/5" (standard in GitLab 17+).
   */
  async createTask(
    namespacePath: string,
    parentWorkItemId: string,
    options: { title: string; description?: string; labels?: string[] },
  ): Promise<GitLabWorkItem> {
    // First, get the project's namespace ID via GraphQL
    const nsData = await this.graphql<{
      namespace: { id: string };
    }>(
      `query($path: ID!) {
        namespace(fullPath: $path) { id }
      }`,
      { path: namespacePath },
    );

    if (!nsData.namespace?.id) {
      throw new Error(`Namespace not found: ${namespacePath}`);
    }

    const data = await this.graphql<{
      workItemCreate: {
        workItem: GitLabWorkItem;
        errors: string[];
      };
    }>(
      `mutation($input: WorkItemCreateInput!) {
        workItemCreate(input: $input) {
          workItem {
            id
            iid
            title
            state
            workItemType { name }
          }
          errors
        }
      }`,
      {
        input: {
          namespacePath,
          title: options.title,
          description: options.description ?? '',
          workItemTypeId: 'gid://gitlab/WorkItems::Type/5', // Task
          hierarchyWidget: { parentId: parentWorkItemId },
        },
      },
    );

    if (data.workItemCreate.errors?.length) {
      throw new Error(`createTask: ${data.workItemCreate.errors.join(', ')}`);
    }

    const workItem = data.workItemCreate.workItem;
    this.logger.log(`Created GitLab task "${workItem.title}" (${workItem.id}) under ${parentWorkItemId}`);
    return workItem;
  }

  /** Get children (tasks) of a work item */
  async getWorkItemChildren(workItemId: string): Promise<GitLabWorkItem[]> {
    const data = await this.graphql<{
      workItem: {
        widgets: Array<{
          type: string;
          children?: { nodes: GitLabWorkItem[] };
        }>;
      };
    }>(
      `query($id: WorkItemID!) {
        workItem(id: $id) {
          widgets {
            type
            ... on WorkItemWidgetHierarchy {
              children { nodes { id iid title state workItemType { name } } }
            }
          }
        }
      }`,
      { id: workItemId },
    );

    const hierarchy = data.workItem?.widgets?.find(w => w.type === 'HIERARCHY');
    return hierarchy?.children?.nodes ?? [];
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
