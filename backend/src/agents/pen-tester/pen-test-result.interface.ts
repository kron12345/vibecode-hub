export interface SecurityFinding {
  category: string;
  severity: 'info' | 'warning' | 'critical';
  description: string;
  file?: string;
  line?: number;
  recommendation: string;
}

export interface PenTestResult {
  issueId: string;
  passed: boolean;
  findings: SecurityFinding[];
  summary: string;
  auditResult?: {
    vulnerabilities: number;
    critical: number;
    high: number;
  };
}
