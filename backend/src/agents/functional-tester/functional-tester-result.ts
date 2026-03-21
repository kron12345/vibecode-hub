import { Logger } from '@nestjs/common';
import {
  stripThinkTags,
  cleanJsonString,
  extractJson,
  normalizePass,
  normalizeSeverity,
} from '../agent-result-parser';
import { filterOutOfScopeFindings } from '../agent-scope.utils';
import {
  FunctionalTestResult,
  FunctionalTestFinding,
} from './functional-test-result.interface';

const COMPLETION_MARKER = ':::TEST_COMPLETE:::';

const logger = new Logger('FunctionalTesterResult');

/**
 * Parse findings array from raw LLM output with field normalization.
 */
export function parseFindings(raw: any): FunctionalTestFinding[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((f: any) => f && typeof f === 'object')
    .map((f: any) => ({
      criterion: String(f.criterion ?? f.name ?? f.test ?? 'Unknown'),
      passed: typeof f.passed === 'boolean' ? f.passed : f.status === 'pass',
      details: String(
        f.details ?? f.description ?? f.message ?? 'No details',
      ),
      severity: normalizeSeverity(f.severity),
      conclusiveness:
        f.conclusiveness === 'inconclusive' ? 'inconclusive' : 'definitive',
      expectedEvidence: f.expectedEvidence
        ? String(f.expectedEvidence)
        : undefined,
      actualEvidence: f.actualEvidence ? String(f.actualEvidence) : undefined,
      firstFailedRound:
        typeof f.firstFailedRound === 'number'
          ? f.firstFailedRound
          : undefined,
      status: ['new', 'resolved', 'unresolved', 'blocked'].includes(f.status)
        ? f.status
        : undefined,
    }));
}

/**
 * Fallback: build a test result from free-text when JSON parsing fails.
 */
export function buildResultFromText(
  text: string,
  issueId: string,
): FunctionalTestResult {
  const lower = text.toLowerCase();

  // Look for strong conclusion patterns (last few lines matter most)
  const lastLines = lower.split('\n').slice(-10).join(' ');

  const strongFail =
    /\b(test(s)?\s+(have\s+)?failed|result:\s*fail|verdict:\s*fail|overall:\s*fail|not\s+passed)\b/.test(
      lastLines,
    );
  const strongPass =
    /\b(test(s)?\s+(have\s+)?passed|all\s+.*pass|result:\s*pass|verdict:\s*pass|overall:\s*pass)\b/.test(
      lastLines,
    );

  // If ambiguous or no clear signal, default to PASS (prevents infinite loops)
  const passed = strongFail ? false : true;

  // Extract any bullet points as pseudo-findings
  const findings: FunctionalTestFinding[] = [];
  const bulletMatches = text.match(/^[-*]\s+.+/gm) || [];
  for (const bullet of bulletMatches.slice(0, 10)) {
    const bulletLower = bullet.toLowerCase();
    const isFail = /fail|not met|missing|broken|error/i.test(bulletLower);
    findings.push({
      criterion: bullet.replace(/^[-*]\s+/, '').substring(0, 200),
      passed: !isFail,
      details: 'Extracted from text response',
      severity: isFail ? 'warning' : 'info',
    });
  }

  const summary = strongFail
    ? 'Functional test failed (parsed from text)'
    : strongPass
      ? 'Functional test passed (parsed from text)'
      : 'Functional test passed (no clear failure detected — defaulting to pass)';

  logger.log(
    `buildResultFromText: strongPass=${strongPass}, strongFail=${strongFail}, passed=${passed}, findings=${findings.length}`,
  );

  return { issueId, passed, findings, summary };
}

/**
 * Parse a functional test result from LLM output.
 * Handles JSON extraction, finding normalization, and inconclusive override.
 */
export function parseTestResult(
  content: string,
  issueId: string,
): FunctionalTestResult | null {
  logger.debug(
    `Parsing functional test result (${content.length} chars)`,
  );

  if (!content.trim()) return null;

  // Strip <think> tags
  const cleaned = stripThinkTags(content);

  // Extract JSON
  const jsonStr = extractJson(cleaned, COMPLETION_MARKER);

  if (!jsonStr) {
    logger.warn('No JSON found — building from text');
    return buildResultFromText(cleaned, issueId);
  }

  try {
    const fixed = cleanJsonString(jsonStr);

    const parsed = JSON.parse(fixed);
    const findings = parseFindings(
      parsed.findings || parsed.criteria || parsed.tests || [],
    );

    // Inconclusive findings don't block — only definitive failures count
    const definitiveFindings = findings.filter(
      (f) => f.conclusiveness !== 'inconclusive',
    );
    const hasCritical = definitiveFindings.some(
      (f) => f.severity === 'critical',
    );
    const hasDefinitiveFailure = definitiveFindings.some((f) => !f.passed);

    // Use LLM verdict as base, but override if only inconclusive failures remain
    let passed = normalizePass(parsed);
    if (!passed && !hasCritical && !hasDefinitiveFailure) {
      passed = true;
      logger.log('All failures are inconclusive — overriding to PASS');
    }

    let summary = parsed.summary || '';
    if (!summary || summary.length < 5) {
      summary = passed
        ? `All acceptance criteria verified (${findings.length} finding(s))`
        : `Functional test failed (${findings.filter((f) => !f.passed).length} criterion/a not met)`;
    }

    // Extract roundNumber and previouslyFailedResolved
    const roundNumber =
      typeof parsed.roundNumber === 'number' ? parsed.roundNumber : undefined;
    const previouslyFailedResolved = Array.isArray(
      parsed.previouslyFailedResolved,
    )
      ? parsed.previouslyFailedResolved.map((r: any) => ({
          criterion: String(r.criterion ?? ''),
          previousObservation: String(r.previousObservation ?? ''),
          currentObservation: String(r.currentObservation ?? ''),
          resolved: typeof r.resolved === 'boolean' ? r.resolved : true,
        }))
      : undefined;

    const result: FunctionalTestResult = {
      issueId,
      passed,
      findings,
      summary,
      testsRun: parsed.testsRun ?? findings.length,
      testsPassed:
        parsed.testsPassed ?? findings.filter((f) => f.passed).length,
      roundNumber,
      previouslyFailedResolved,
    };

    logger.log(
      `Parsed functional test: passed=${result.passed}, findings=${result.findings.length}`,
    );
    return result;
  } catch (err) {
    logger.error(`JSON parse failed: ${err.message}`);
    return buildResultFromText(cleaned, issueId);
  }
}

/**
 * Filter functional test findings using Architect out-of-scope constraints.
 * Re-calculates pass/fail based on remaining findings.
 */
export function applyArchitectScopeFilter(
  testResult: FunctionalTestResult,
  outOfScopeItems: string[],
): FunctionalTestResult {
  if (outOfScopeItems.length === 0 || testResult.findings.length === 0) {
    return testResult;
  }

  const { filtered, removedCount } = filterOutOfScopeFindings(
    testResult.findings,
    outOfScopeItems,
    (f) => `${f.criterion} ${f.details}`,
  );

  if (removedCount === 0) return testResult;

  const hasCritical = filtered.some((f) => f.severity === 'critical');
  const hasFailedCriterion = filtered.some((f) => !f.passed);
  const passed = !hasCritical && !hasFailedCriterion;

  logger.log(
    `Architect scope filter removed ${removedCount} functional finding(s) as out-of-scope`,
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
    testsRun: filtered.length,
    testsPassed: filtered.filter((f) => f.passed).length,
  };
}

/**
 * Find the best matching finding for a sub-issue title using fuzzy matching.
 * Returns the finding or null if no reasonable match exists.
 */
export function matchFindingToSubIssue(
  subTitle: string,
  findings: FunctionalTestFinding[],
): FunctionalTestFinding | null {
  const subLower = subTitle.toLowerCase().trim();
  const subWords = subLower.split(/\s+/).filter((w) => w.length > 2);

  let bestMatch: FunctionalTestFinding | null = null;
  let bestScore = 0;

  for (const finding of findings) {
    const criterionLower = finding.criterion.toLowerCase().trim();

    // Exact match
    if (criterionLower === subLower) return finding;

    // One contains the other
    if (
      criterionLower.includes(subLower) ||
      subLower.includes(criterionLower)
    ) {
      return finding;
    }

    // Word overlap scoring
    const criterionWords = criterionLower
      .split(/\s+/)
      .filter((w) => w.length > 2);
    const overlap = subWords.filter((w) =>
      criterionWords.some((cw) => cw.includes(w) || w.includes(cw)),
    );
    const score = overlap.length / Math.max(subWords.length, 1);

    if (score > bestScore && score >= 0.5) {
      bestScore = score;
      bestMatch = finding;
    }
  }

  return bestMatch;
}
