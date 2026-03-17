/** Finding status relative to previous test round */
export type FindingStatus = 'new' | 'resolved' | 'unresolved' | 'blocked';

export interface SecurityFinding {
  category: string;
  severity: 'info' | 'warning' | 'critical';
  description: string;
  file?: string;
  line?: number;
  recommendation: string;
  /** Concrete secure code pattern the pen tester expects (Expectation Pattern) */
  expectedFix?: string;
  /** Concrete exploit scenario proving the vulnerability is real */
  exploitScenario?: string;
  /** How the pen tester verified this finding */
  verificationMethod?: string;
  /** Round number since which this finding persists */
  persistsSinceRound?: number;
  /** Delta vs. previous round */
  status?: FindingStatus;
}

export interface ResolvedSecurityFinding {
  category: string;
  description: string;
  resolvedBy: string;
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
  /** Current test round number */
  roundNumber?: number;
  /** Security findings from previous round that were resolved */
  resolvedFromPrevious?: ResolvedSecurityFinding[];
}
