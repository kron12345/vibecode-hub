export interface ReviewFinding {
  severity: 'info' | 'warning' | 'critical';
  file: string;
  line?: number;
  message: string;
  suggestion?: string;
}

export interface ReviewResult {
  issueId: string;
  mrIid: number;
  approved: boolean;
  findings: ReviewFinding[];
  summary: string;
}
