export interface UiTestFinding {
  type: 'layout' | 'responsive' | 'accessibility' | 'visual' | 'interaction';
  page: string;
  description: string;
  severity: 'info' | 'warning' | 'critical';
  screenshot?: string;
}

export interface UiTestResult {
  issueId: string;
  passed: boolean;
  findings: UiTestFinding[];
  summary: string;
  pagesChecked: number;
}
