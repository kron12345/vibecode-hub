export interface DocFile {
  path: string;
  content: string;
  action: 'create' | 'update';
  /** If true, sync this file to GitLab Wiki (for high-level docs like Home, Architecture) */
  wikiPage?: boolean;
}

export interface DocumenterResult {
  issueId: string;
  filesUpdated: string[];
  summary: string;
  commitSha?: string;
}
