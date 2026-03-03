export interface DocFile {
  path: string;
  content: string;
  action: 'create' | 'update';
}

export interface DocumenterResult {
  issueId: string;
  filesUpdated: string[];
  summary: string;
  commitSha?: string;
}
