/**
 * GitLab Merge Requests — MR CRUD, diffs, discussions, pipelines, and jobs.
 */
import { firstValueFrom } from 'rxjs';
import { GitlabWikiService } from './gitlab-wiki.service';
import {
  GitLabMergeRequest,
  GitLabMrDiff,
  GitLabDiscussion,
  GitLabDiscussionNote,
  GitLabPipeline,
  GitLabJob,
  MrDiscussionPosition,
  CreateMergeRequestOptions,
} from './gitlab.interfaces';

export class GitlabMrService extends GitlabWikiService {
  // ─── Merge Requests ───────────────────────────────────────

  async createMergeRequest(
    projectId: number,
    options: CreateMergeRequestOptions,
  ): Promise<GitLabMergeRequest> {
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
    this.logger.log(
      `Created MR !${data.iid} in project ${projectId}: ${options.source_branch} → ${options.target_branch}`,
    );
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
  async findMergeRequestByBranch(
    projectId: number,
    sourceBranch: string,
  ): Promise<GitLabMergeRequest | null> {
    try {
      const { data } = await firstValueFrom(
        this.httpService.get<GitLabMergeRequest[]>(
          `${this.apiUrl}/projects/${projectId}/merge_requests`,
          {
            headers: this.headers,
            params: {
              source_branch: sourceBranch,
              state: 'opened',
              per_page: 1,
            },
          },
        ),
      );
      return data.length > 0 ? data[0] : null;
    } catch {
      return null;
    }
  }

  async getMergeRequest(
    projectId: number,
    mrIid: number,
  ): Promise<GitLabMergeRequest> {
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
      const relevant = data.filter(
        (d) =>
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

  // ─── MR Discussions (Finding Threads) ─────────────────────

  /**
   * Create a discussion thread on a merge request.
   * If position is provided, creates a diff-bound thread on a specific line.
   * Otherwise creates a general (non-diff) thread.
   */
  async createMrDiscussion(
    projectId: number,
    mrIid: number,
    body: string,
    position?: MrDiscussionPosition,
  ): Promise<GitLabDiscussion> {
    const payload: Record<string, unknown> = { body };
    if (position) {
      payload.position = position;
    }

    const { data } = await firstValueFrom(
      this.httpService.post<GitLabDiscussion>(
        `${this.apiUrl}/projects/${projectId}/merge_requests/${mrIid}/discussions`,
        payload,
        { headers: this.headers },
      ),
    );
    this.logger.debug(
      `Created MR discussion on !${mrIid} (id: ${data.id}, diff: ${!!position})`,
    );
    return data;
  }

  /**
   * List all discussion threads on a merge request (paginated).
   * Returns both resolved and unresolved threads.
   */
  async listMrDiscussions(
    projectId: number,
    mrIid: number,
    options?: { maxPages?: number },
  ): Promise<GitLabDiscussion[]> {
    const maxPages = options?.maxPages ?? 10;
    const collected: GitLabDiscussion[] = [];

    for (let page = 1; page <= maxPages; page++) {
      const { data } = await firstValueFrom(
        this.httpService.get<GitLabDiscussion[]>(
          `${this.apiUrl}/projects/${projectId}/merge_requests/${mrIid}/discussions`,
          {
            headers: this.headers,
            params: { per_page: 100, page },
          },
        ),
      );

      if (!data || data.length === 0) break;
      collected.push(...data);
      if (data.length < 100) break;
    }

    return collected;
  }

  /**
   * Resolve or unresolve a discussion thread on a merge request.
   */
  async resolveMrDiscussion(
    projectId: number,
    mrIid: number,
    discussionId: string,
    resolved: boolean,
  ): Promise<GitLabDiscussion> {
    const { data } = await firstValueFrom(
      this.httpService.put<GitLabDiscussion>(
        `${this.apiUrl}/projects/${projectId}/merge_requests/${mrIid}/discussions/${discussionId}`,
        { resolved },
        { headers: this.headers },
      ),
    );
    this.logger.debug(
      `${resolved ? 'Resolved' : 'Reopened'} MR discussion ${discussionId} on !${mrIid}`,
    );
    return data;
  }

  /**
   * Reply to an existing discussion thread on a merge request.
   */
  async replyToMrDiscussion(
    projectId: number,
    mrIid: number,
    discussionId: string,
    body: string,
  ): Promise<GitLabDiscussionNote> {
    const { data } = await firstValueFrom(
      this.httpService.post<GitLabDiscussionNote>(
        `${this.apiUrl}/projects/${projectId}/merge_requests/${mrIid}/discussions/${discussionId}/notes`,
        { body },
        { headers: this.headers },
      ),
    );
    this.logger.debug(`Replied to MR discussion ${discussionId} on !${mrIid}`);
    return data;
  }

  // ─── Pipelines ────────────────────────────────────────────

  async getPipeline(
    projectId: number,
    pipelineId: number,
  ): Promise<GitLabPipeline> {
    const { data } = await firstValueFrom(
      this.httpService.get<GitLabPipeline>(
        `${this.apiUrl}/projects/${projectId}/pipelines/${pipelineId}`,
        { headers: this.headers },
      ),
    );
    return data;
  }

  async getPipelineJobs(
    projectId: number,
    pipelineId: number,
  ): Promise<GitLabJob[]> {
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
}
