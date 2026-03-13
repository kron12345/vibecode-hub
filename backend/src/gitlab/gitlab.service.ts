import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import FormData = require('form-data');
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

export interface GitLabMilestone {
  id: number;
  iid: number;
  title: string;
  description: string | null;
  state: 'active' | 'closed';
  due_date: string | null;
  start_date: string | null;
  web_url: string;
  created_at: string;
  updated_at: string;
}

export interface GitLabNote {
  id: number;
  body: string;
  author: { id: number; username: string; name: string };
  created_at: string;
  updated_at: string;
  system: boolean;
}

export interface GitLabMergeRequest {
  id: number;
  iid: number;
  title: string;
  description: string | null;
  state: 'opened' | 'closed' | 'merged' | 'locked';
  source_branch: string;
  target_branch: string;
  web_url: string;
  merge_status: string;
  has_conflicts: boolean;
  created_at: string;
  updated_at: string;
}

export interface GitLabMrDiff {
  old_path: string;
  new_path: string;
  diff: string;
  new_file: boolean;
  deleted_file: boolean;
  renamed_file: boolean;
}

export interface GitLabPipeline {
  id: number;
  iid: number;
  status: 'created' | 'waiting_for_resource' | 'preparing' | 'pending' | 'running' | 'success' | 'failed' | 'canceled' | 'skipped' | 'manual' | 'scheduled';
  ref: string;
  sha: string;
  web_url: string;
  created_at: string;
  updated_at: string;
}

export interface GitLabJob {
  id: number;
  name: string;
  stage: string;
  status: string;
  web_url: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface GitLabBranch {
  name: string;
  commit: { id: string; message: string };
  default: boolean;
  web_url: string;
}

export interface GitLabTreeItem {
  id: string;
  name: string;
  type: 'tree' | 'blob';
  path: string;
  mode: string;
}

export interface GitLabWikiPage {
  slug: string;
  title: string;
  content: string;
  format: string;
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
  milestone_id?: number;
}

interface UpdateIssueOptions {
  title?: string;
  description?: string;
  labels?: string[];
  add_labels?: string[];
  remove_labels?: string[];
  state_event?: 'close' | 'reopen';
  milestone_id?: number;
}

interface CreateMergeRequestOptions {
  source_branch: string;
  target_branch: string;
  title: string;
  description?: string;
  remove_source_branch?: boolean;
}

interface CreateMilestoneOptions {
  title: string;
  description?: string;
  start_date?: string;
  due_date?: string;
}

interface UpdateMilestoneOptions {
  title?: string;
  description?: string;
  start_date?: string;
  due_date?: string;
  state_event?: 'close' | 'activate';
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
      this.logger.log(`Created GitLab project: ${data.path_with_namespace} (ID: ${data.id})`);
      return data;
    } catch (err: any) {
      const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      this.logger.error(`GitLab createProject failed (${options.path}): ${detail}`);
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
      this.httpService.delete(
        `${this.apiUrl}/projects/${projectId}`,
        { headers: this.headers },
      ),
    );
    this.logger.log(`Deleted GitLab project ID: ${projectId}`);
  }

  // ─── Issues ──────────────────────────────────────────────────

  async createIssue(projectId: number, options: CreateIssueOptions): Promise<GitLabIssue> {
    const body: Record<string, unknown> = {
      title: options.title,
      description: options.description ?? '',
      labels: options.labels?.join(',') ?? '',
    };
    if (options.milestone_id !== undefined) {
      body.milestone_id = options.milestone_id;
    }

    const { data } = await firstValueFrom(
      this.httpService.post<GitLabIssue>(
        `${this.apiUrl}/projects/${projectId}/issues`,
        body,
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
    if (options.add_labels !== undefined) body.add_labels = options.add_labels.join(',');
    if (options.remove_labels !== undefined) body.remove_labels = options.remove_labels.join(',');
    if (options.state_event !== undefined) body.state_event = options.state_event;
    if (options.milestone_id !== undefined) body.milestone_id = options.milestone_id;

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

  // ─── Status Labels ────────────────────────────────────────────

  /** All pipeline status labels with their GitLab colors */
  static readonly STATUS_LABELS: Record<string, { label: string; color: string }> = {
    OPEN:         { label: 'status::open',         color: '#428BCA' }, // blue
    IN_PROGRESS:  { label: 'status::in-progress',  color: '#E67E22' }, // orange
    IN_REVIEW:    { label: 'status::in-review',    color: '#9B59B6' }, // purple
    TESTING:      { label: 'status::testing',       color: '#F1C40F' }, // yellow
    NEEDS_REVIEW: { label: 'status::needs-review', color: '#E74C3C' }, // red
    DONE:         { label: 'status::done',          color: '#2ECC71' }, // green
    CLOSED:       { label: 'status::closed',        color: '#95A5A6' }, // gray
  };

  /** Cache: Set of projectIds where labels have been created */
  private readonly labelInitializedProjects = new Set<number>();

  /**
   * Ensure all status labels exist in a GitLab project.
   * Idempotent — caches which projects are initialized.
   */
  async ensureStatusLabels(projectId: number): Promise<void> {
    if (this.labelInitializedProjects.has(projectId)) return;

    for (const { label, color } of Object.values(GitlabService.STATUS_LABELS)) {
      try {
        await firstValueFrom(
          this.httpService.post(
            `${this.apiUrl}/projects/${projectId}/labels`,
            { name: label, color },
            { headers: this.headers },
          ),
        );
        this.logger.debug(`Created label "${label}" in project ${projectId}`);
      } catch (err: any) {
        // 409 = label already exists — that's fine
        if (err.response?.status !== 409) {
          this.logger.warn(`Could not create label "${label}": ${err.response?.status ?? err.message}`);
        }
      }
    }

    this.labelInitializedProjects.add(projectId);
    this.logger.log(`Status labels initialized for project ${projectId}`);
  }

  /**
   * Sync an issue's status as a GitLab label.
   * Removes all other status:: labels, adds the current one.
   */
  async syncStatusLabel(
    projectId: number,
    issueIid: number,
    status: string,
  ): Promise<void> {
    await this.ensureStatusLabels(projectId);

    const current = GitlabService.STATUS_LABELS[status];
    if (!current) return;

    const allStatusLabels = Object.values(GitlabService.STATUS_LABELS).map((l) => l.label);
    const removeLabels = allStatusLabels.filter((l) => l !== current.label);

    await this.updateIssue(projectId, issueIid, {
      add_labels: [current.label],
      remove_labels: removeLabels,
    });
    this.logger.debug(`Synced label "${current.label}" to GitLab issue #${issueIid}`);
  }

  // ─── Milestones ─────────────────────────────────────────────

  async createMilestone(projectId: number, options: CreateMilestoneOptions): Promise<GitLabMilestone> {
    const body: Record<string, unknown> = { title: options.title };
    if (options.description) body.description = options.description;
    if (options.start_date) body.start_date = options.start_date;
    if (options.due_date) body.due_date = options.due_date;

    const { data } = await firstValueFrom(
      this.httpService.post<GitLabMilestone>(
        `${this.apiUrl}/projects/${projectId}/milestones`,
        body,
        { headers: this.headers },
      ),
    );
    this.logger.log(`Created GitLab milestone "${data.title}" (ID: ${data.id}) in project ${projectId}`);
    return data;
  }

  async getMilestones(projectId: number, state?: 'active' | 'closed'): Promise<GitLabMilestone[]> {
    const { data } = await firstValueFrom(
      this.httpService.get<GitLabMilestone[]>(
        `${this.apiUrl}/projects/${projectId}/milestones`,
        {
          headers: this.headers,
          params: {
            state: state ?? 'active',
            per_page: 100,
          },
        },
      ),
    );
    return data;
  }

  async updateMilestone(
    projectId: number,
    milestoneId: number,
    options: UpdateMilestoneOptions,
  ): Promise<GitLabMilestone> {
    const body: Record<string, unknown> = {};
    if (options.title !== undefined) body.title = options.title;
    if (options.description !== undefined) body.description = options.description;
    if (options.start_date !== undefined) body.start_date = options.start_date;
    if (options.due_date !== undefined) body.due_date = options.due_date;
    if (options.state_event !== undefined) body.state_event = options.state_event;

    const { data } = await firstValueFrom(
      this.httpService.put<GitLabMilestone>(
        `${this.apiUrl}/projects/${projectId}/milestones/${milestoneId}`,
        body,
        { headers: this.headers },
      ),
    );
    this.logger.log(`Updated GitLab milestone ${milestoneId} in project ${projectId}`);
    return data;
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

  // ─── Notes (Issue Comments) ─────────────────────────────────

  async createIssueNote(projectId: number, issueIid: number, body: string): Promise<GitLabNote> {
    const { data } = await firstValueFrom(
      this.httpService.post<GitLabNote>(
        `${this.apiUrl}/projects/${projectId}/issues/${issueIid}/notes`,
        { body },
        { headers: this.headers },
      ),
    );
    this.logger.debug(`Created note on issue #${issueIid} in project ${projectId}`);
    return data;
  }

  async getIssueNotes(projectId: number, issueIid: number): Promise<GitLabNote[]> {
    const { data } = await firstValueFrom(
      this.httpService.get<GitLabNote[]>(
        `${this.apiUrl}/projects/${projectId}/issues/${issueIid}/notes`,
        {
          headers: this.headers,
          params: { per_page: 100, sort: 'asc' },
        },
      ),
    );
    return data;
  }

  // ─── Merge Requests ────────────────────────────────────────

  async createMergeRequest(projectId: number, options: CreateMergeRequestOptions): Promise<GitLabMergeRequest> {
    const { data } = await firstValueFrom(
      this.httpService.post<GitLabMergeRequest>(
        `${this.apiUrl}/projects/${projectId}/merge_requests`,
        {
          source_branch: options.source_branch,
          target_branch: options.target_branch,
          title: options.title,
          description: options.description ?? '',
          remove_source_branch: options.remove_source_branch ?? true,
        },
        { headers: this.headers },
      ),
    );
    this.logger.log(`Created MR !${data.iid} in project ${projectId}: ${options.source_branch} → ${options.target_branch}`);
    return data;
  }

  /**
   * Accept (merge) a merge request.
   * Squash-merges by default and removes the source branch.
   */
  async acceptMergeRequest(
    projectId: number,
    mrIid: number,
    options?: { squash?: boolean; removeSourceBranch?: boolean },
  ): Promise<GitLabMergeRequest> {
    const { data } = await firstValueFrom(
      this.httpService.put<GitLabMergeRequest>(
        `${this.apiUrl}/projects/${projectId}/merge_requests/${mrIid}/merge`,
        {
          squash: options?.squash ?? true,
          should_remove_source_branch: options?.removeSourceBranch ?? true,
        },
        { headers: this.headers },
      ),
    );
    this.logger.log(`Merged MR !${mrIid} in project ${projectId}`);
    return data;
  }

  /**
   * Find an existing open MR by source branch.
   * Returns the first matching MR or null if none found.
   */
  async findMergeRequestByBranch(projectId: number, sourceBranch: string): Promise<GitLabMergeRequest | null> {
    try {
      const { data } = await firstValueFrom(
        this.httpService.get<GitLabMergeRequest[]>(
          `${this.apiUrl}/projects/${projectId}/merge_requests`,
          {
            headers: this.headers,
            params: { source_branch: sourceBranch, state: 'opened', per_page: 1 },
          },
        ),
      );
      return data.length > 0 ? data[0] : null;
    } catch {
      return null;
    }
  }

  async getMergeRequest(projectId: number, mrIid: number): Promise<GitLabMergeRequest> {
    const { data } = await firstValueFrom(
      this.httpService.get<GitLabMergeRequest>(
        `${this.apiUrl}/projects/${projectId}/merge_requests/${mrIid}`,
        { headers: this.headers },
      ),
    );
    return data;
  }

  /**
   * Fetch MR diffs with pagination. Skips node_modules and other generated paths.
   * Fetches up to maxPages pages, collecting up to maxDiffs relevant diffs.
   */
  async getMergeRequestDiffs(
    projectId: number,
    mrIid: number,
    options?: { maxDiffs?: number; maxPages?: number },
  ): Promise<GitLabMrDiff[]> {
    const maxDiffs = options?.maxDiffs ?? 50;
    const maxPages = options?.maxPages ?? 10;
    const collected: GitLabMrDiff[] = [];

    for (let page = 1; page <= maxPages; page++) {
      const { data } = await firstValueFrom(
        this.httpService.get<GitLabMrDiff[]>(
          `${this.apiUrl}/projects/${projectId}/merge_requests/${mrIid}/diffs`,
          {
            headers: this.headers,
            params: { per_page: 100, page },
          },
        ),
      );

      if (!data || data.length === 0) break;

      // Filter out generated/vendored paths
      const relevant = data.filter(d =>
        !d.new_path.includes('node_modules/') &&
        !d.new_path.includes('vendor/') &&
        !d.new_path.endsWith('.lock') &&
        !d.new_path.endsWith('-lock.json'),
      );

      collected.push(...relevant);

      if (collected.length >= maxDiffs) {
        return collected.slice(0, maxDiffs);
      }

      // If this page had less than 100 results, there are no more pages
      if (data.length < 100) break;
    }

    return collected;
  }

  // ─── Branches ──────────────────────────────────────────────

  async createBranch(projectId: number, name: string, ref: string): Promise<GitLabBranch> {
    const { data } = await firstValueFrom(
      this.httpService.post<GitLabBranch>(
        `${this.apiUrl}/projects/${projectId}/repository/branches`,
        { branch: name, ref },
        { headers: this.headers },
      ),
    );
    this.logger.log(`Created branch "${name}" from "${ref}" in project ${projectId}`);
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

  // ─── Pipelines ─────────────────────────────────────────────

  async getPipeline(projectId: number, pipelineId: number): Promise<GitLabPipeline> {
    const { data } = await firstValueFrom(
      this.httpService.get<GitLabPipeline>(
        `${this.apiUrl}/projects/${projectId}/pipelines/${pipelineId}`,
        { headers: this.headers },
      ),
    );
    return data;
  }

  async getPipelineJobs(projectId: number, pipelineId: number): Promise<GitLabJob[]> {
    const { data } = await firstValueFrom(
      this.httpService.get<GitLabJob[]>(
        `${this.apiUrl}/projects/${projectId}/pipelines/${pipelineId}/jobs`,
        {
          headers: this.headers,
          params: { per_page: 100 },
        },
      ),
    );
    return data;
  }

  async getJobLog(projectId: number, jobId: number): Promise<string> {
    const { data } = await firstValueFrom(
      this.httpService.get<string>(
        `${this.apiUrl}/projects/${projectId}/jobs/${jobId}/trace`,
        {
          headers: this.headers,
          responseType: 'text' as any,
        },
      ),
    );
    return data;
  }

  // ─── Repository ────────────────────────────────────────────

  async getRepositoryTree(projectId: number, ref: string, path?: string): Promise<GitLabTreeItem[]> {
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

  // ─── Members ─────────────────────────────────────────────────

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
      this.logger.log(`Added user ${userId} as member (level ${accessLevel}) to project ${projectId}`);
    } catch (err: any) {
      // 409 = already a member — that's fine
      if (err?.response?.status === 409) {
        this.logger.debug(`User ${userId} already member of project ${projectId}`);
        return;
      }
      throw err;
    }
  }

  // ─── Wiki ──────────────────────────────────────────────────────

  async listWikiPages(projectId: number): Promise<GitLabWikiPage[]> {
    const { data } = await firstValueFrom(
      this.httpService.get<GitLabWikiPage[]>(
        `${this.apiUrl}/projects/${projectId}/wikis`,
        { headers: this.headers },
      ),
    );
    return data;
  }

  async getWikiPage(projectId: number, slug: string): Promise<GitLabWikiPage> {
    const { data } = await firstValueFrom(
      this.httpService.get<GitLabWikiPage>(
        `${this.apiUrl}/projects/${projectId}/wikis/${encodeURIComponent(slug)}`,
        { headers: this.headers },
      ),
    );
    return data;
  }

  async createWikiPage(
    projectId: number,
    title: string,
    content: string,
    format: 'markdown' | 'rdoc' | 'asciidoc' = 'markdown',
  ): Promise<GitLabWikiPage> {
    const { data } = await firstValueFrom(
      this.httpService.post<GitLabWikiPage>(
        `${this.apiUrl}/projects/${projectId}/wikis`,
        { title, content, format },
        { headers: this.headers },
      ),
    );
    this.logger.log(`Created wiki page "${title}" in project ${projectId}`);
    return data;
  }

  async updateWikiPage(
    projectId: number,
    slug: string,
    title: string,
    content: string,
  ): Promise<GitLabWikiPage> {
    const { data } = await firstValueFrom(
      this.httpService.put<GitLabWikiPage>(
        `${this.apiUrl}/projects/${projectId}/wikis/${encodeURIComponent(slug)}`,
        { title, content },
        { headers: this.headers },
      ),
    );
    this.logger.log(`Updated wiki page "${slug}" in project ${projectId}`);
    return data;
  }

  async deleteWikiPage(projectId: number, slug: string): Promise<void> {
    await firstValueFrom(
      this.httpService.delete(
        `${this.apiUrl}/projects/${projectId}/wikis/${encodeURIComponent(slug)}`,
        { headers: this.headers },
      ),
    );
    this.logger.log(`Deleted wiki page "${slug}" in project ${projectId}`);
  }

  /**
   * Create or update a wiki page. Tries create first;
   * on conflict (page exists), falls back to update.
   */
  async upsertWikiPage(
    projectId: number,
    title: string,
    content: string,
  ): Promise<GitLabWikiPage> {
    const slug = title.toLowerCase().replace(/\s+/g, '-');
    try {
      return await this.createWikiPage(projectId, title, content);
    } catch (err: any) {
      // 400 or 409 = page already exists → update
      const status = err?.response?.status ?? err?.status;
      if (status === 400 || status === 409) {
        return this.updateWikiPage(projectId, slug, title, content);
      }
      throw err;
    }
  }

  // ─── File Uploads ───────────────────────────────────────────

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

    this.logger.log(`Uploaded file "${fileName}" to project ${projectId}: ${data.markdown}`);
    return {
      markdown: data.markdown,
      url: data.url,
      fullPath: data.full_path,
    };
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
