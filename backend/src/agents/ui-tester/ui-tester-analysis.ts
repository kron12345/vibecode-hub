/**
 * Visual analysis logic for UI Tester agent.
 * Handles screenshot analysis via multimodal LLM, browser data formatting,
 * manifest updates, route extraction from diffs, and LLM prompt construction.
 */
import { Logger } from '@nestjs/common';
import { LlmService } from '../../llm/llm.service';
import { LlmContentPart } from '../../llm/llm.interfaces';
import { SystemSettingsService } from '../../settings/system-settings.service';
import { AgentRoleConfig } from '../../settings/system-settings.service';
import { ScreenshotManifest } from './ui-test-result.interface';
import { PageCapture, A11yResult, PlaywrightRunner } from './playwright-runner';
import { GitlabService } from '../../gitlab/gitlab.service';
import * as path from 'path';
import {
  extractLastAgentFindings,
  extractLoopResolverClarifications,
} from '../agent-comment.utils';
import { buildArchitectScopeGuardSection } from '../agent-scope.utils';
import * as fs from 'fs/promises';

const logger = new Logger('UiTesterAnalysis');

export const COMPLETION_MARKER = ':::UI_TEST_COMPLETE:::';

/**
 * Send screenshots to a multimodal LLM for visual analysis.
 * Returns a text description of each screenshot's appearance, layout, and issues.
 */
export async function analyzeScreenshots(
  llmService: LlmService,
  settings: SystemSettingsService,
  config: AgentRoleConfig,
  images: Array<{ base64: string; label: string }>,
  issueTitle: string,
): Promise<string> {
  // Build multimodal content: text prompt + images interleaved
  const contentParts: LlmContentPart[] = [
    {
      type: 'text',
      text: `You are a UI/UX expert reviewing screenshots of a web application.
Issue being tested: "${issueTitle}"

Below are ${images.length} screenshot(s) captured from the application. For EACH screenshot:

1. **Describe** the visual appearance: layout, colors, typography, spacing, alignment
2. **Identify issues**: broken layouts, overlapping elements, poor contrast, inconsistent styling, missing content, visual glitches
3. **Rate** the overall visual quality (good/acceptable/poor)

Label each description with the screenshot label provided.
Use this exact format for each:

### [Screenshot Label]
**Description:** ...
**Issues:** ... (or "None found")
**Visual Quality:** good/acceptable/poor
`,
    },
  ];

  for (const img of images) {
    contentParts.push({
      type: 'text',
      text: `\n--- Screenshot: ${img.label} ---`,
    });
    contentParts.push({
      type: 'image',
      mediaType: 'image/png',
      base64: img.base64,
    });
  }

  // Use the configured provider — but only if it supports multimodal.
  // CLI providers (CLAUDE_CODE, CODEX_CLI, etc.) don't support inline images.
  // Fallback chain: ANTHROPIC > GOOGLE > OPENAI > configured provider
  let provider = config.provider;
  const cliProviders = [
    'CLAUDE_CODE',
    'CODEX_CLI',
    'GEMINI_CLI',
    'QWEN3_CODER',
  ];
  if (cliProviders.includes(provider)) {
    // Try cloud providers that support multimodal
    for (const fallback of ['ANTHROPIC', 'GOOGLE', 'OPENAI']) {
      const fbConfig = settings.get(
        `llm.${fallback.toLowerCase()}.apiKey`,
        undefined,
        '',
      );
      if (fbConfig) {
        provider = fallback;
        logger.log(
          `Visual analysis: CLI provider ${config.provider} doesn't support images, falling back to ${provider}`,
        );
        break;
      }
    }
    // If no cloud provider available, fall back to Ollama (supports images with multimodal models)
    if (cliProviders.includes(provider)) {
      provider = 'OLLAMA';
      logger.log(
        'Visual analysis: falling back to OLLAMA for multimodal',
      );
    }
  }

  // When falling back to a different provider, use an appropriate model
  let model = config.model;
  if (provider === 'OLLAMA' && !model.startsWith('llava') && !model.startsWith('qwen')) {
    model = 'llava:13b'; // Default multimodal Ollama model
    logger.log(`Visual analysis: using ${model} for Ollama multimodal (original: ${config.model})`);
  }

  const result = await llmService.complete({
    provider,
    model,
    messages: [{ role: 'user', content: contentParts }],
    temperature: 0.2,
    maxTokens: config.parameters.maxTokens,
  });

  if (result.finishReason === 'error' || !result.content) {
    logger.warn('Visual screenshot analysis returned no content');
    return '';
  }

  logger.log(
    `Visual analysis: ${result.content.length} chars from ${provider}/${config.model}`,
  );
  return result.content;
}

/**
 * Parse the LLM visual analysis and update the manifest with per-screenshot descriptions.
 */
export async function updateManifestDescriptions(
  manifestPath: string,
  visualAnalysis: string,
): Promise<void> {
  if (!visualAnalysis) return;

  try {
    const raw = await fs.readFile(manifestPath, 'utf-8');
    const manifest: ScreenshotManifest = JSON.parse(raw);

    // Parse analysis sections: look for "### [label]" headers
    const sections = visualAnalysis.split(/^###\s+/m).filter(Boolean);

    for (const section of sections) {
      const lines = section.trim().split('\n');
      const headerLine = lines[0]?.trim() ?? '';
      // Strip markdown formatting from header (brackets, bold, etc.)
      const sectionLabel = headerLine.replace(/[[\]]/g, '').trim();
      const sectionBody = lines.slice(1).join('\n').trim();

      // Match section to manifest entry by comparing labels with screenshot metadata
      for (const entry of manifest.screenshots) {
        const entryLabel = `${entry.route} — ${entry.viewport}`;
        // Fuzzy match: check if section header contains route and viewport info
        if (
          sectionLabel.includes(entry.route) ||
          sectionLabel.includes(entry.viewport) ||
          sectionLabel.toLowerCase().includes(entryLabel.toLowerCase()) ||
          entryLabel.toLowerCase().includes(sectionLabel.toLowerCase())
        ) {
          entry.description = sectionBody.substring(0, 2000);

          // Extract findings from the "Issues:" line
          const issuesMatch = sectionBody.match(
            /\*\*Issues?:\*\*\s*(.+?)(?:\n|$)/i,
          );
          if (issuesMatch) {
            const issuesText = issuesMatch[1].trim();
            if (!/^none/i.test(issuesText) && issuesText.length > 3) {
              entry.findings = entry.findings ?? [];
              entry.findings.push(issuesText);
            }
          }
          break;
        }
      }
    }

    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    logger.log(`Manifest updated with ${sections.length} descriptions`);
  } catch (err) {
    logger.warn(
      `Failed to update manifest descriptions: ${err.message}`,
    );
  }
}

/**
 * Format browser data (page captures, accessibility, responsive) into a text section
 * suitable for inclusion in the LLM prompt.
 */
export function formatBrowserData(
  captures: PageCapture[],
  a11y: A11yResult | null,
  responsive: any,
): string {
  const parts: string[] = [];

  // Page captures (omit base64 for LLM prompt — too large)
  if (captures.length > 0) {
    parts.push('### Page Captures:');
    for (const c of captures) {
      parts.push(`**${c.route}**`);
      if (c.consoleErrors.length > 0) {
        parts.push(
          `- Console Errors: ${c.consoleErrors.slice(0, 5).join('; ')}`,
        );
      } else {
        parts.push('- No console errors');
      }
      // Include a DOM summary (first 2000 chars)
      const domSummary = c.domSnapshot.substring(0, 2000);
      parts.push(
        `- DOM snapshot (first 2000 chars):\n\`\`\`html\n${domSummary}\n\`\`\``,
      );
      parts.push('');
    }
  }

  // Accessibility results
  if (a11y) {
    parts.push('### Accessibility Audit:');
    parts.push(`- Route: ${a11y.route}`);
    parts.push(`- Passes: ${a11y.passes}`);
    parts.push(`- Violations: ${a11y.violations.length}`);
    for (const v of a11y.violations.slice(0, 10)) {
      parts.push(
        `  - **${v.impact}**: ${v.description} (${v.nodes} element(s)) — ${v.id}`,
      );
    }
    parts.push('');
  }

  // Responsive results
  if (responsive?.captures?.length > 0) {
    parts.push('### Responsive Check:');
    for (const rc of responsive.captures) {
      parts.push(
        `- ${rc.viewport} (${rc.width}x${rc.height}): Screenshot captured`,
      );
    }
    parts.push('');
  }

  return parts.join('\n');
}

/**
 * Extract testable routes from MR diffs by looking for route definitions
 * and page component file paths.
 */
export function extractRoutesFromDiffs(diffs: any[]): string[] {
  const routes = new Set<string>();

  for (const d of diffs) {
    // Look for Angular/React route definitions
    const routeMatches = d.diff.matchAll(/path:\s*['"`]([^'"`]+)['"`]/g);
    for (const match of routeMatches) {
      const route = match[1].startsWith('/') ? match[1] : `/${match[1]}`;
      routes.add(route);
    }

    // Look for component file paths that suggest pages
    const pathMatch = d.new_path.match(/pages?\/([^/]+)/);
    if (pathMatch) {
      routes.add(
        `/${pathMatch[1].replace(/\.(component|page)\.(ts|tsx|vue|svelte)$/, '')}`,
      );
    }
  }

  return [...routes].slice(0, 5); // Max 5 routes
}

/** Result of collecting screenshots from page captures. */
export interface ScreenshotCollectionResult {
  screenshotImages: Array<{ base64: string; label: string }>;
  screenshotManifestPath: string | undefined;
}

/**
 * Collect base64 screenshot images from Playwright captures and save a manifest file.
 * Returns up to 6 images for multimodal LLM analysis.
 */
export async function collectAndSaveScreenshots(
  runner: PlaywrightRunner,
  workspace: string,
  issueId: string,
  issueTitle: string,
  captures: PageCapture[],
  responsive: any,
): Promise<ScreenshotCollectionResult> {
  let screenshotImages: Array<{ base64: string; label: string }> = [];
  let screenshotManifestPath: string | undefined;

  try {
    const saved = await runner.saveScreenshots(
      workspace, issueId, captures, responsive,
    );

    for (const capture of captures) {
      if (capture.screenshotBase64) {
        screenshotImages.push({
          base64: capture.screenshotBase64,
          label: `${capture.route} — desktop (1440x900)`,
        });
      }
    }
    if (responsive?.captures) {
      for (const rc of responsive.captures) {
        if (rc.screenshotBase64) {
          screenshotImages.push({
            base64: rc.screenshotBase64,
            label: `${responsive.route} — ${rc.viewport} (${rc.width}x${rc.height})`,
          });
        }
      }
    }
    screenshotImages = screenshotImages.slice(0, 6);

    screenshotManifestPath = path.join(saved.dir, 'manifest.json');
    const manifest: ScreenshotManifest = {
      issueId,
      issueTitle,
      capturedAt: new Date().toISOString(),
      screenshotDir: saved.dir,
      screenshots: saved.files.map((f) => ({
        file: f.file,
        route: f.route,
        viewport: f.viewport,
        description: '',
      })),
    };
    await fs.writeFile(
      screenshotManifestPath,
      JSON.stringify(manifest, null, 2),
    );
    logger.log(
      `Screenshots saved: ${saved.files.length} files, manifest at ${screenshotManifestPath}`,
    );
  } catch (err) {
    logger.warn(`Failed to save screenshots: ${err.message}`);
  }

  return { screenshotImages, screenshotManifestPath };
}

/**
 * Build the diff text section from MR diffs, filtering to UI-related files only.
 */
export function buildDiffText(diffs: any[]): {
  reviewDiffs: any[];
  diffText: string;
} {
  const MAX_DIFFS = 20;
  const MAX_DIFF_CHARS = 2000;
  const reviewDiffs = diffs
    .filter((d) =>
      /\.(html|css|scss|tsx|jsx|ts|js|vue|svelte|java)$/.test(d.new_path),
    )
    .slice(0, MAX_DIFFS);

  const diffText = reviewDiffs
    .map((d) => {
      const prefix = d.new_file
        ? '[NEW]'
        : d.deleted_file
          ? '[DELETED]'
          : '[MODIFIED]';
      const truncated =
        d.diff.length > MAX_DIFF_CHARS
          ? d.diff.substring(0, MAX_DIFF_CHARS) + '\n... (truncated)'
          : d.diff;
      return `### ${prefix} ${d.new_path}\n\`\`\`diff\n${truncated}\n\`\`\``;
    })
    .join('\n\n');

  return { reviewDiffs, diffText };
}

/**
 * Build the complete user prompt for the UI tester LLM call.
 */
export function buildUserPrompt(
  issue: { title: string; description: string | null },
  previewUrl: string | null,
  diffs: any[],
  commentHistory: string,
  outOfScopeItems: string[],
  browserData: string,
  visualAnalysis: string,
): string {
  const historySection = commentHistory
    ? `\n## Previous Agent Comments on this Issue\n${commentHistory}\n`
    : '';
  const scopeGuardSection = buildArchitectScopeGuardSection(outOfScopeItems);
  const previousFindings = extractLastAgentFindings(
    commentHistory,
    'UI Tester',
  );
  const previousFindingsSection =
    previousFindings.length > 0
      ? `\n## YOUR Previous UI Test Findings — Re-Evaluate Each One\n${previousFindings
          .map(
            (f, i) =>
              `${i + 1}. [${(f.severity ?? 'warning').toUpperCase()}] ${f.message}\n   → NOW CHECK: is this still present in the current code/screenshots?`,
          )
          .join(
            '\n',
          )}\n\nFor each finding above: if fixed, report in \`resolvedFromPrevious\`. If still present, carry forward with SAME description.\n`
      : '';
  const loopResolverSection =
    extractLoopResolverClarifications(commentHistory);

  const { reviewDiffs, diffText } = buildDiffText(diffs);

  return `Analyze the UI changes in this merge request${previousFindings.length > 0 ? ' (Re-test after fix attempt)' : ''}:

**Issue:** ${issue.title}
**Description:** ${issue.description || 'N/A'}
${previewUrl ? `**Preview URL:** ${previewUrl}` : ''}
${loopResolverSection ? `\n${loopResolverSection}\n` : ''}${previousFindingsSection}${historySection}
${scopeGuardSection}
## Code Changes (${reviewDiffs.length} UI-related file(s)):

${diffText || '_No UI-related files changed._'}

${browserData ? `## Browser Test Results:\n\n${browserData}` : ''}
${visualAnalysis ? `## Visual Screenshot Analysis:\n\n${visualAnalysis}` : ''}

${
  previousFindings.length > 0
    ? 'IMPORTANT: First address each item in "YOUR Previous UI Test Findings" above, then check for new issues.'
    : 'Analyze the UI changes for layout, responsiveness, accessibility, visual quality, and interactions.'
}

IMPORTANT: You MUST end your response with the JSON result in this EXACT format:
${COMPLETION_MARKER}
\`\`\`json
{"passed": true/false, "summary": "...", "pagesChecked": 0, "roundNumber": 1, "findings": [{"type": "layout|responsive|accessibility|visual|interaction", "page": "/path", "description": "...", "severity": "info/warning/critical", "expectedState": "...", "observedState": "...", "status": "new|unresolved|blocked"}]}
\`\`\`
Do NOT omit the JSON block.`;
}

/**
 * Fetch MR diffs with retry logic. Returns empty array if all attempts fail.
 */
export async function fetchDiffsWithRetry(
  gitlabService: GitlabService,
  gitlabProjectId: number,
  mrIid: number,
  maxRetries: number,
  delayMs: number,
): Promise<any[]> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const diffs = await gitlabService.getMergeRequestDiffs(
        gitlabProjectId,
        mrIid,
      );
      if (diffs.length > 0) return diffs;
    } catch (err) {
      logger.warn(
        `Diff fetch attempt ${attempt}/${maxRetries} failed for MR !${mrIid}: ${err.message}`,
      );
    }
    if (attempt < maxRetries) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  logger.warn(
    `MR !${mrIid} still has no diffs after ${maxRetries} attempts`,
  );
  return [];
}
