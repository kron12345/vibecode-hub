export interface CoderIssueResult {
  issueId: string;
  gitlabIid: number | null;
  branch: string;
  mrIid?: number;
  mrUrl?: string;
  commitSha?: string;
  commitUrl?: string;
  filesChanged: string[];
  status: 'success' | 'failed' | 'skipped';
  error?: string;
  durationMs: number;
}

export interface CoderMilestoneResult {
  milestoneId: string;
  milestoneTitle: string;
  issueResults: CoderIssueResult[];
  counts: {
    total: number;
    success: number;
    failed: number;
    skipped: number;
  };
}
