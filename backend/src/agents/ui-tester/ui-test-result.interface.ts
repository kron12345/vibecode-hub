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
  /** Path to the screenshot manifest JSON, if screenshots were captured */
  screenshotManifestPath?: string;
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
