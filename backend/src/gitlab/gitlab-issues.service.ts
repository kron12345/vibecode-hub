/**
 * GitLab Issues — Issue CRUD, labels, status sync, milestones,
 * notes (comments), and Work Items (GraphQL).
 */
import { firstValueFrom } from 'rxjs';
import { GitlabCoreService } from './gitlab-core.service';
import {
  GitLabIssue,
  GitLabMilestone,
  GitLabNote,
  GitLabWorkItem,
  CreateIssueOptions,
  UpdateIssueOptions,
  CreateMilestoneOptions,
  UpdateMilestoneOptions,
} from './gitlab.interfaces';

export class GitlabIssuesService extends GitlabCoreService {
  // ─── Issues ───────────────────────────────────────────────

  async createIssue(
    projectId: number,
    options: CreateIssueOptions,
  ): Promise<GitLabIssue> {
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
    this.logger.log(
      `Created GitLab issue #${data.iid} in project ${projectId}`,
    );
    return data;
  }

  async getIssues(
    projectId: number,
    state?: 'opened' | 'closed' | 'all',
  ): Promise<GitLabIssue[]> {
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
    if (options.description !== undefined)
      body.description = options.description;
    if (options.labels !== undefined) body.labels = options.labels.join(',');
    if (options.add_labels !== undefined)
      body.add_labels = options.add_labels.join(',');
    if (options.remove_labels !== undefined)
      body.remove_labels = options.remove_labels.join(',');
    if (options.state_event !== undefined)
      body.state_event = options.state_event;
    if (options.milestone_id !== undefined)
      body.milestone_id = options.milestone_id;

    const { data } = await firstValueFrom(
      this.httpService.put<GitLabIssue>(
        `${this.apiUrl}/projects/${projectId}/issues/${issueIid}`,
        body,
        { headers: this.headers },
      ),
    );
    this.logger.log(
      `Updated GitLab issue #${issueIid} in project ${projectId}`,
    );
    return data;
  }

  async closeIssue(projectId: number, issueIid: number): Promise<GitLabIssue> {
    return this.updateIssue(projectId, issueIid, { state_event: 'close' });
  }

  // ─── Status Labels ────────────────────────────────────────

  /** All pipeline status labels with their GitLab colors */
  static readonly STATUS_LABELS: Record<
    string,
    { label: string; color: string }
  > = {
    OPEN: { label: 'status::open', color: '#428BCA' }, // blue
    IN_PROGRESS: { label: 'status::in-progress', color: '#E67E22' }, // orange
    IN_REVIEW: { label: 'status::in-review', color: '#9B59B6' }, // purple
    TESTING: { label: 'status::testing', color: '#F1C40F' }, // yellow
    NEEDS_REVIEW: { label: 'status::needs-review', color: '#E74C3C' }, // red
    DONE: { label: 'status::done', color: '#2ECC71' }, // green
    CLOSED: { label: 'status::closed', color: '#95A5A6' }, // gray
  };

  /** Cache: Set of projectIds where labels have been created */
  private readonly labelInitializedProjects = new Set<number>();

  /**
   * Ensure all status labels exist in a GitLab project.
   * Idempotent — caches which projects are initialized.
   */
  async ensureStatusLabels(projectId: number): Promise<void> {
    if (this.labelInitializedProjects.has(projectId)) return;

    for (const { label, color } of Object.values(
      GitlabIssuesService.STATUS_LABELS,
    )) {
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
          this.logger.warn(
            `Could not create label "${label}": ${err.response?.status ?? err.message}`,
          );
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

    const current = GitlabIssuesService.STATUS_LABELS[status];
    if (!current) return;

    const allStatusLabels = Object.values(
      GitlabIssuesService.STATUS_LABELS,
    ).map((l) => l.label);
    const removeLabels = allStatusLabels.filter((l) => l !== current.label);

    await this.updateIssue(projectId, issueIid, {
      add_labels: [current.label],
      remove_labels: removeLabels,
    });
    this.logger.debug(
      `Synced label "${current.label}" to GitLab issue #${issueIid}`,
    );
  }

  // ─── Milestones ───────────────────────────────────────────

  async createMilestone(
    projectId: number,
    options: CreateMilestoneOptions,
  ): Promise<GitLabMilestone> {
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
    this.logger.log(
      `Created GitLab milestone "${data.title}" (ID: ${data.id}) in project ${projectId}`,
    );
    return data;
  }

  async getMilestones(
    projectId: number,
    state?: 'active' | 'closed',
  ): Promise<GitLabMilestone[]> {
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
    if (options.description !== undefined)
      body.description = options.description;
    if (options.start_date !== undefined) body.start_date = options.start_date;
    if (options.due_date !== undefined) body.due_date = options.due_date;
    if (options.state_event !== undefined)
      body.state_event = options.state_event;

    const { data } = await firstValueFrom(
      this.httpService.put<GitLabMilestone>(
        `${this.apiUrl}/projects/${projectId}/milestones/${milestoneId}`,
        body,
        { headers: this.headers },
      ),
    );
    this.logger.log(
      `Updated GitLab milestone ${milestoneId} in project ${projectId}`,
    );
    return data;
  }

  // ─── Notes (Issue Comments) ───────────────────────────────

  async createIssueNote(
    projectId: number,
    issueIid: number,
    body: string,
  ): Promise<GitLabNote> {
    const { data } = await firstValueFrom(
      this.httpService.post<GitLabNote>(
        `${this.apiUrl}/projects/${projectId}/issues/${issueIid}/notes`,
        { body },
        { headers: this.headers },
      ),
    );
    this.logger.debug(
      `Created note on issue #${issueIid} in project ${projectId}`,
    );
    return data;
  }

  async getIssueNotes(
    projectId: number,
    issueIid: number,
  ): Promise<GitLabNote[]> {
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

  // ─── Work Items (GraphQL) ─────────────────────────────────

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
      throw new Error(
        `WorkItem ID not found for issue #${issueIid} in ${projectPath}`,
      );
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
    this.logger.log(
      `Created GitLab task "${workItem.title}" (${workItem.id}) under ${parentWorkItemId}`,
    );
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

    const hierarchy = data.workItem?.widgets?.find(
      (w) => w.type === 'HIERARCHY',
    );
    return hierarchy?.children?.nodes ?? [];
  }
}
