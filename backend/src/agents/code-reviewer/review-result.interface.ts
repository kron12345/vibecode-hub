/** Finding status relative to previous review round */
export type FindingStatus = 'new' | 'resolved' | 'unresolved' | 'blocked';

export interface ReviewFinding {
  severity: 'info' | 'warning' | 'critical';
  file: string;
  line?: number;
  message: string;
  suggestion?: string;
  /** Concrete code snippet or pattern the reviewer expects to see (Expectation Pattern) */
  expectedFix?: string;
  /** Round number when this finding was first reported (loop detection) */
  firstReportedRound?: number;
  /** Delta vs. previous round */
  status?: FindingStatus;
}

export interface ResolvedFinding {
  message: string;
  resolvedBy: string;
}

export interface ReviewResult {
  issueId: string;
  mrIid: number;
  approved: boolean;
  findings: ReviewFinding[];
  summary: string;
  /** Current review round number */
  roundNumber?: number;
  /** Findings from previous round that were successfully resolved */
  resolvedFromPrevious?: ResolvedFinding[];
}
