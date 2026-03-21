/**
 * GitLab API type definitions and option interfaces.
 * Shared across all gitlab-*.service.ts files.
 */

// ─── Response Types ──────────────────────────────────────────

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
  diff_refs?: {
    base_sha: string;
    head_sha: string;
    start_sha: string;
  };
  created_at: string;
  updated_at: string;
}

export interface GitLabDiscussionNote {
  id: number;
  body: string;
  author: { id: number; username: string; name: string };
  created_at: string;
  type: string | null;
  resolvable: boolean;
  resolved?: boolean;
  position?: {
    old_path: string;
    new_path: string;
    old_line: number | null;
    new_line: number | null;
  };
}

export interface GitLabDiscussion {
  id: string;
  individual_note: boolean;
  notes: GitLabDiscussionNote[];
}

/** Position for creating a diff-bound discussion thread */
export interface MrDiscussionPosition {
  position_type: 'text';
  base_sha: string;
  head_sha: string;
  start_sha: string;
  old_path: string;
  new_path: string;
  new_line: number;
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
  status:
    | 'created'
    | 'waiting_for_resource'
    | 'preparing'
    | 'pending'
    | 'running'
    | 'success'
    | 'failed'
    | 'canceled'
    | 'skipped'
    | 'manual'
    | 'scheduled';
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
  id: string; // "gid://gitlab/WorkItem/123"
  iid: string; // Project-scoped IID
  title: string;
  state: string;
  workItemType: { name: string };
}

// ─── Request Option Types ────────────────────────────────────

export interface CreateProjectOptions {
  name: string;
  path: string;
  description?: string;
  initializeWithReadme?: boolean;
}

export interface CreateIssueOptions {
  title: string;
  description?: string;
  labels?: string[];
  milestone_id?: number;
}

export interface UpdateIssueOptions {
  title?: string;
  description?: string;
  labels?: string[];
  add_labels?: string[];
  remove_labels?: string[];
  state_event?: 'close' | 'reopen';
  milestone_id?: number;
}

export interface CreateMergeRequestOptions {
  source_branch: string;
  target_branch: string;
  title: string;
  description?: string;
  remove_source_branch?: boolean;
}

export interface CreateMilestoneOptions {
  title: string;
  description?: string;
  start_date?: string;
  due_date?: string;
}

export interface UpdateMilestoneOptions {
  title?: string;
  description?: string;
  start_date?: string;
  due_date?: string;
  state_event?: 'close' | 'activate';
}
