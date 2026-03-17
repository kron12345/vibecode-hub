/** Finding status relative to previous test round */
export type FindingStatus = 'new' | 'resolved' | 'unresolved' | 'blocked';

export interface UiTestFinding {
  type: 'layout' | 'responsive' | 'accessibility' | 'visual' | 'interaction';
  page: string;
  description: string;
  severity: 'info' | 'warning' | 'critical';
  screenshot?: string;
  /** Whether this finding can be verified from code alone (false = needs runtime/browser) */
  verifiableFromCode?: boolean;
  /** Expected visual/code state (Expectation Pattern) */
  expectedState?: string;
  /** Currently observed state */
  observedState?: string;
  /** Round number since which this finding persists */
  persistsSinceRound?: number;
  /** Delta vs. previous round */
  status?: FindingStatus;
}

export interface ResolvedUiFinding {
  type: string;
  page: string;
  description: string;
  resolvedBy: string;
}

export interface UiTestResult {
  issueId: string;
  passed: boolean;
  findings: UiTestFinding[];
  summary: string;
  pagesChecked: number;
  /** Path to the screenshot manifest JSON, if screenshots were captured */
  screenshotManifestPath?: string;
  /** Current test round number */
  roundNumber?: number;
  /** Findings from previous round that were resolved */
  resolvedFromPrevious?: ResolvedUiFinding[];
}

/** A single screenshot entry in the manifest. */
export interface ScreenshotEntry {
  file: string;
  route: string;
  viewport: string;
  description: string;
  findings?: string[];
}

/** Manifest file saved alongside screenshots for the Documenter to consume. */
export interface ScreenshotManifest {
  issueId: string;
  issueTitle: string;
  capturedAt: string;
  screenshotDir: string;
  screenshots: ScreenshotEntry[];
}
