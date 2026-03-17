/** Finding status relative to previous test round */
export type FindingStatus = 'new' | 'resolved' | 'unresolved' | 'blocked';

export interface FunctionalTestFinding {
  criterion: string;
  passed: boolean;
  details: string;
  severity?: 'info' | 'warning' | 'critical';
  /** Whether this finding is definitively verifiable or needs runtime confirmation */
  conclusiveness?: 'definitive' | 'inconclusive';
  /** What the tester expects to see (Expectation Pattern) */
  expectedEvidence?: string;
  /** What the tester actually observed */
  actualEvidence?: string;
  /** Round number when this criterion first failed */
  firstFailedRound?: number;
  /** Delta vs. previous round */
  status?: FindingStatus;
}

export interface ResolvedCriterion {
  criterion: string;
  previousObservation: string;
  currentObservation: string;
  resolved: boolean;
}

export interface FunctionalTestResult {
  issueId: string;
  passed: boolean;
  findings: FunctionalTestFinding[];
  summary: string;
  testsRun?: number;
  testsPassed?: number;
  /** Current test round number */
  roundNumber?: number;
  /** Previously failed criteria that are now resolved */
  previouslyFailedResolved?: ResolvedCriterion[];
}
