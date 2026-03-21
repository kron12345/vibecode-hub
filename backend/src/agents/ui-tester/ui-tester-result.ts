/**
 * Result parsing, finding normalization, scope filtering, and dual-test
 * merging helpers for the UI Tester agent.
 */
import { Logger } from '@nestjs/common';
import {
  UiTestResult,
  UiTestFinding,
} from './ui-test-result.interface';
import {
  stripThinkTags,
  cleanJsonString,
  extractJson,
  normalizePass,
  normalizeSeverity,
} from '../agent-result-parser';
import { filterOutOfScopeFindings } from '../agent-scope.utils';
import {
  FindingForThread,
  syncFindingThreads,
  buildIssueSummaryWithThreadLinks,
} from '../finding-thread.utils';
import { postAgentComment } from '../agent-comment.utils';
import { PrismaService } from '../../prisma/prisma.service';
import { GitlabService } from '../../gitlab/gitlab.service';
import { AgentRole } from '@prisma/client';

const logger = new Logger('UiTesterResult');

const COMPLETION_MARKER = ':::UI_TEST_COMPLETE:::';

/**
 * Parse LLM response content into a structured UiTestResult.
 * Falls back to text-based heuristic if JSON extraction fails.
 */
export function parseTestResult(
  content: string,
  issueId: string,
): UiTestResult | null {
  logger.debug(`Parsing UI test result (${content.length} chars)`);

  if (!content.trim()) return null;

  const cleaned = stripThinkTags(content);

  const jsonStr = extractJson(cleaned, COMPLETION_MARKER);

  if (!jsonStr) {
    logger.warn('No JSON found in UI test result — building from text');
    return buildResultFromText(cleaned, issueId);
  }

  try {
    const fixed = cleanJsonString(jsonStr);

    const parsed = JSON.parse(fixed);
    const passed = normalizePass(parsed);
    const findings = parseFindings(parsed.findings || parsed.issues || []);

    let summary = parsed.summary || '';
    if (!summary || summary.length < 5) {
      summary = passed
        ? `UI test passed (${findings.length} finding(s))`
        : `UI test failed (${findings.filter((f) => f.severity !== 'info').length} issue(s))`;
    }

    const result: UiTestResult = {
      issueId,
      passed,
      findings,
      summary,
      pagesChecked: parsed.pagesChecked ?? 0,
    };

    if (typeof parsed.roundNumber === 'number') {
      result.roundNumber = parsed.roundNumber;
    }

    if (Array.isArray(parsed.resolvedFromPrevious)) {
      result.resolvedFromPrevious = parsed.resolvedFromPrevious
        .filter((r: any) => r && typeof r === 'object' && r.description)
        .map((r: any) => ({
          type: String(r.type ?? 'visual'),
          page: String(r.page ?? '/'),
          description: String(r.description),
          resolvedBy: String(r.resolvedBy ?? 'unknown'),
        }));
    }

    return result;
  } catch (err) {
    logger.error(`JSON parse failed: ${err.message}`);
    return buildResultFromText(cleaned, issueId);
  }
}

/**
 * Parse raw finding objects from LLM JSON into typed UiTestFinding[].
 */
export function parseFindings(raw: any): UiTestFinding[] {
  if (!Array.isArray(raw)) return [];
  const validTypes = [
    'layout',
    'responsive',
    'accessibility',
    'visual',
    'interaction',
  ];
  return raw
    .filter((f: any) => f && typeof f === 'object')
    .map((f: any) => ({
      type: validTypes.includes(f.type) ? f.type : 'visual',
      page: String(f.page ?? f.route ?? f.url ?? '/'),
      description: String(
        f.description ?? f.message ?? f.details ?? 'No details',
      ),
      severity: normalizeSeverity(f.severity),
      verifiableFromCode:
        typeof f.verifiableFromCode === 'boolean'
          ? f.verifiableFromCode
          : undefined,
      expectedState: f.expectedState ? String(f.expectedState) : undefined,
      observedState: f.observedState ? String(f.observedState) : undefined,
      persistsSinceRound:
        typeof f.persistsSinceRound === 'number'
          ? f.persistsSinceRound
          : undefined,
      status: ['new', 'resolved', 'unresolved', 'blocked'].includes(f.status)
        ? f.status
        : undefined,
    }));
}

/**
 * Build a UiTestResult from unstructured text when JSON extraction fails.
 * Defaults to pass unless a strong failure signal is detected.
 */
export function buildResultFromText(
  text: string,
  issueId: string,
): UiTestResult {
  const lower = text.toLowerCase();
  const lastLines = lower.split('\n').slice(-10).join(' ');

  const strongFail =
    /\b(test(s)?\s+(have\s+)?failed|result:\s*fail|verdict:\s*fail|overall:\s*fail|critical\s+issue)\b/.test(
      lastLines,
    );
  // Default to pass if no clear failure signal (prevents infinite loops)
  const passed = !strongFail;

  logger.log(
    `buildResultFromText: strongFail=${strongFail}, passed=${passed}`,
  );

  return {
    issueId,
    passed,
    findings: [],
    summary: strongFail
      ? 'UI test failed (parsed from text)'
      : 'UI test passed (no clear failure detected — defaulting to pass)',
    pagesChecked: 0,
  };
}

/**
 * Filter out findings that the Architect marked as out-of-scope.
 * Re-evaluates the passed flag based on remaining findings.
 */
export function applyArchitectScopeFilter(
  testResult: UiTestResult,
  outOfScopeItems: string[],
): UiTestResult {
  if (outOfScopeItems.length === 0 || testResult.findings.length === 0) {
    return testResult;
  }

  const { filtered, removedCount } = filterOutOfScopeFindings(
    testResult.findings,
    outOfScopeItems,
    (f) => `${f.type} ${f.page} ${f.description}`,
  );

  if (removedCount === 0) return testResult;

  const criticalCount = filtered.filter(
    (f) => f.severity === 'critical',
  ).length;
  const warningCount = filtered.filter(
    (f) => f.severity === 'warning',
  ).length;
  const passed = criticalCount === 0 && warningCount <= 3;

  logger.log(
    `Architect scope filter removed ${removedCount} UI finding(s) as out-of-scope`,
  );

  const summarySuffix = `Architect scope filter ignored ${removedCount} out-of-scope finding(s).`;
  const summary = testResult.summary
    ? `${testResult.summary} ${summarySuffix}`
    : summarySuffix;

  return {
    ...testResult,
    passed,
    findings: filtered,
    summary,
  };
}

/**
 * Convert UiTestFinding[] into FindingForThread[] for MR discussion threads.
 */
export function buildFindingsForThreads(
  findings: UiTestFinding[],
): FindingForThread[] {
  const activeFindings = findings.filter((f) => f.severity !== 'info');
  return activeFindings.map((f) => {
    const parts = [
      `**${f.severity.toUpperCase()}** [${f.type}] — \`${f.page}\``,
      '',
      f.description,
    ];
    if (f.expectedState) parts.push('', `**Expected:** ${f.expectedState}`);
    if (f.observedState) parts.push('', `**Observed:** ${f.observedState}`);
    if (f.verifiableFromCode === false)
      parts.push('', '_Warning: Needs browser verification_');
    return {
      severity: f.severity,
      message: `[${f.type}] ${f.page}: ${f.description.substring(0, 80)}`,
      threadBody: parts.join('\n'),
    };
  });
}

/**
 * Build structured feedback text from test findings for the coder agent.
 */
export function buildFailureFeedback(findings: UiTestFinding[]): string {
  const relevantFindings = findings.filter((f) => f.severity !== 'info');
  return relevantFindings
    .map((f, i) => {
      const persist = f.persistsSinceRound
        ? ` (open since round ${f.persistsSinceRound})`
        : '';
      const verifiable =
        f.verifiableFromCode === false ? ' [needs browser verification]' : '';
      const parts = [
        `${i + 1}. [${f.severity.toUpperCase()}] [${f.type}] ${f.page}${persist}${verifiable}`,
      ];
      parts.push(`   Problem: ${f.description}`);
      if (f.expectedState) parts.push(`   Expected: ${f.expectedState}`);
      if (f.observedState) parts.push(`   Observed: ${f.observedState}`);
      return parts.join('\n');
    })
    .join('\n\n');
}

/**
 * Build the dual-test fingerprint key for deduplicating findings during merge.
 */
export function dualTestFindingKey(f: UiTestFinding): string {
  return `${f.type}:${f.page}:${f.description.substring(0, 40).toLowerCase()}`;
}

/**
 * Post finding threads to the MR and a summary comment on the GitLab issue.
 */
export async function postFindingThreadsAndComment(opts: {
  prisma: PrismaService;
  gitlabService: GitlabService;
  issueId: string;
  mrIid: number;
  gitlabProjectId: number;
  issueIid: number;
  agentTaskId: string;
  testResult: UiTestResult;
}): Promise<void> {
  const { prisma, gitlabService, issueId, mrIid, gitlabProjectId, issueIid, agentTaskId, testResult } = opts;

  const findingsForThreads = buildFindingsForThreads(testResult.findings);

  const {
    activeThreads: allActiveThreads,
    resolvedThreads: resolvedThreadRecords,
  } = await syncFindingThreads({
    prisma,
    gitlabService,
    issueId,
    mrIid,
    gitlabProjectId,
    agentRole: AgentRole.UI_TESTER,
    roundNumber: testResult.roundNumber ?? 1,
    findings: findingsForThreads,
    confirmedResolved: testResult.resolvedFromPrevious?.map((r: any) => ({
      message: r.description,
    })),
  });

  const testMarkdown = buildIssueSummaryWithThreadLinks({
    agentName: 'UI Test',
    approved: testResult.passed,
    summary: testResult.summary,
    threads: allActiveThreads,
    resolvedThreads: resolvedThreadRecords,
  });
  await postAgentComment({
    prisma,
    gitlabService,
    issueId,
    gitlabProjectId,
    issueIid,
    agentTaskId,
    authorName: 'UI Tester',
    markdownContent: testMarkdown,
  });
}
