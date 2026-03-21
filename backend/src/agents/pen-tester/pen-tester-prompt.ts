/**
 * User prompt builder for the Pen Tester agent.
 *
 * Extracted from pen-tester.agent.ts — constructs the full user prompt
 * with tech-stack context, previous findings, history, scope guards,
 * diffs, and audit/header reports.
 */

import { COMPLETION_MARKER } from './pen-tester-result';

export interface PenTesterPromptInput {
  issueTitle: string;
  issueDescription: string | null;
  techStackContext: string;
  maxWarnings: number;
  loopResolverSection: string;
  previousFindingsSection: string;
  historySection: string;
  scopeGuardSection: string;
  reviewDiffCount: number;
  totalDiffCount: number;
  diffText: string;
  auditReport: string;
  headerReport: string;
  hasPreviousFindings: boolean;
}

/**
 * Build the user prompt for the Pen Tester LLM call.
 */
export function buildPenTesterUserPrompt(input: PenTesterPromptInput): string {
  return `Perform a security analysis of this merge request${input.hasPreviousFindings ? ' (Re-test after fix attempt)' : ''}:

**Issue:** ${input.issueTitle}
**Description:** ${input.issueDescription || 'N/A'}

## Project Context
${input.techStackContext}

**Warning threshold:** PASS if ≤${input.maxWarnings} warnings and 0 critical findings.
${input.loopResolverSection ? `\n${input.loopResolverSection}\n` : ''}${input.previousFindingsSection}${input.historySection}
${input.scopeGuardSection}
## MR Diffs (${input.reviewDiffCount} of ${input.totalDiffCount} file(s)):

${input.diffText || '_No diffs available._'}

${input.auditReport ? `## npm audit Results (production dependencies only):\n\n${input.auditReport}` : ''}

${input.headerReport ? `## Security Headers Check:\n\n${input.headerReport}` : ''}

${
  input.hasPreviousFindings
    ? 'IMPORTANT: First address each item in "YOUR Previous Security Findings" above, then check for new vulnerabilities.'
    : 'Analyze the code for OWASP Top 10 vulnerabilities. Be context-aware: consider the tech stack and project type.'
}

IMPORTANT: You MUST end your response with the JSON result in this EXACT format:
${COMPLETION_MARKER}
\`\`\`json
{"passed": true/false, "summary": "...", "roundNumber": 1, "findings": [{"category": "A03:2021", "severity": "critical/warning/info", "description": "...", "file": "path", "expectedFix": "...", "exploitScenario": "...", "status": "new/unresolved/blocked"}]}
\`\`\`
Do NOT omit the JSON block.`;
}

/**
 * Build the "previous findings" section for re-test rounds.
 */
export function buildPreviousFindingsSection(
  previousFindings: Array<{
    severity?: string;
    file?: string;
    message: string;
    expectedFix?: string;
    suggestion?: string;
  }>,
): string {
  if (previousFindings.length === 0) return '';

  return `\n## YOUR Previous Security Findings — Re-Evaluate Each One\n${previousFindings
    .map(
      (f, i) =>
        `${i + 1}. [${(f.severity ?? 'warning').toUpperCase()}] ${f.file ? `\`${f.file}\`: ` : ''}${f.message}\n   Expected fix: ${f.expectedFix ?? f.suggestion ?? 'not specified'}\n   → NOW CHECK: is this vulnerability still present in the current code?`,
    )
    .join(
      '\n',
    )}\n\nFor each finding above: if fixed, report in \`resolvedFromPrevious\`. If still present, carry forward with SAME description.\n`;
}
