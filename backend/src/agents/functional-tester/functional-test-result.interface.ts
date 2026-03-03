export interface FunctionalTestFinding {
  criterion: string;
  passed: boolean;
  details: string;
  severity?: 'info' | 'warning' | 'critical';
}

export interface FunctionalTestResult {
  issueId: string;
  passed: boolean;
  findings: FunctionalTestFinding[];
  summary: string;
  testsRun?: number;
  testsPassed?: number;
}
