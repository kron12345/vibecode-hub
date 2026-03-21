/**
 * Result parsing, finding normalization, scope filtering, and
 * finding-to-thread conversion for the Pen Tester agent.
 *
 * Extracted from pen-tester.agent.ts — keeps all result interpretation
 * logic in one place.
 */

import { Logger } from '@nestjs/common';
import {
  stripThinkTags,
  cleanJsonString,
  extractJson,
  normalizeSeverity,
} from '../agent-result-parser';
import { filterOutOfScopeFindings } from '../agent-scope.utils';
import { FindingForThread } from '../finding-thread.utils';
import { PenTestResult, SecurityFinding } from './pen-test-result.interface';

export const COMPLETION_MARKER = ':::SECURITY_TEST_COMPLETE:::';

// ─── Result Parsing ──────────────────────────────────────

/**
 * Parse the raw LLM/MCP response into a structured PenTestResult.
 * Falls back to text-based heuristics when JSON extraction fails.
 */
export function parseTestResult(
  content: string,
  issueId: string,
  auditResult: PenTestResult['auditResult'] | undefined,
  maxWarnings: number,
  logger: Logger,
): PenTestResult | null {
  logger.debug(`Parsing security test result (${content.length} chars)`);

  if (!content.trim()) return null;

  const cleaned = stripThinkTags(content);

  const jsonStr = extractJson(cleaned, COMPLETION_MARKER);

  if (!jsonStr) {
    logger.warn(
      'No JSON found in security test result — building from text',
    );
    return buildResultFromText(cleaned, issueId, auditResult, logger);
  }

  try {
    const fixed = cleanJsonString(jsonStr);

    const parsed = JSON.parse(fixed);
    const findings = parseFindings(
      parsed.findings || parsed.vulnerabilities || parsed.issues || [],
    );

    // Apply configurable threshold instead of trusting LLM decision blindly
    const criticalCount = findings.filter(
      (f) => f.severity === 'critical',
    ).length;
    const warningCount = findings.filter(
      (f) => f.severity === 'warning',
    ).length;
    const passed = criticalCount === 0 && warningCount <= maxWarnings;

    let summary = parsed.summary || '';
    if (!summary || summary.length < 5) {
      summary = passed
        ? `Security test passed (${findings.length} finding(s), ${warningCount} warning(s))`
        : `Security test failed (${criticalCount} critical, ${warningCount} warning(s))`;
    }

    // Extract roundNumber and resolvedFromPrevious from LLM output
    const roundNumber =
      typeof parsed.roundNumber === 'number' ? parsed.roundNumber : undefined;
    const resolvedFromPrevious = Array.isArray(parsed.resolvedFromPrevious)
      ? parsed.resolvedFromPrevious
          .filter((r: any) => r && typeof r === 'object')
          .map((r: any) => ({
            category: String(r.category ?? 'Unknown'),
            description: String(r.description ?? ''),
            resolvedBy: String(r.resolvedBy ?? ''),
          }))
      : undefined;

    return {
      issueId,
      passed,
      findings,
      summary,
      auditResult: parsed.auditResult || auditResult,
      roundNumber,
      resolvedFromPrevious,
    };
  } catch (err) {
    logger.error(`JSON parse failed: ${err.message}`);
    return buildResultFromText(cleaned, issueId, auditResult, logger);
  }
}

// ─── Finding Normalization ───────────────────────────────

export function parseFindings(raw: any): SecurityFinding[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((f: any) => f && typeof f === 'object')
    .map((f: any) => ({
      category: String(f.category ?? f.owasp ?? f.type ?? 'Unknown'),
      severity: normalizeSeverity(f.severity),
      description: String(
        f.description ?? f.message ?? f.details ?? 'No details',
      ),
      file: f.file ? String(f.file) : undefined,
      line: typeof f.line === 'number' ? f.line : undefined,
      recommendation: String(
        f.recommendation ?? f.fix ?? f.suggestion ?? 'Review and fix',
      ),
      expectedFix: f.expectedFix ? String(f.expectedFix) : undefined,
      exploitScenario: f.exploitScenario
        ? String(f.exploitScenario)
        : undefined,
      verificationMethod: f.verificationMethod
        ? String(f.verificationMethod)
        : undefined,
      persistsSinceRound:
        typeof f.persistsSinceRound === 'number'
          ? f.persistsSinceRound
          : undefined,
      status: ['new', 'resolved', 'unresolved', 'blocked'].includes(f.status)
        ? f.status
        : undefined,
    }));
}

// ─── Text Fallback ───────────────────────────────────────

export function buildResultFromText(
  text: string,
  issueId: string,
  auditResult: PenTestResult['auditResult'] | undefined,
  logger: Logger,
): PenTestResult {
  const lower = text.toLowerCase();
  const lastLines = lower.split('\n').slice(-10).join(' ');

  // Only fail on strong evidence of critical security issues
  const strongFail =
    /\b(critical\s+vulnerabilit|sql\s+injection\s+found|xss\s+exploit|rce\s+found|result:\s*fail|verdict:\s*fail)\b/.test(
      lastLines,
    );
  const passed = !strongFail;

  logger.log(
    `buildResultFromText: strongFail=${strongFail}, passed=${passed}`,
  );

  return {
    issueId,
    passed,
    findings: [],
    summary: strongFail
      ? 'Security test failed (parsed from text)'
      : 'Security test passed (no critical vulnerabilities detected — defaulting to pass)',
    auditResult,
  };
}

// ─── Architect Scope Filter ──────────────────────────────

/**
 * Remove findings that the Architect explicitly marked as out-of-scope
 * and recalculate the pass/fail decision.
 */
export function applyArchitectScopeFilter(
  testResult: PenTestResult,
  outOfScopeItems: string[],
  maxWarnings: number,
  logger: Logger,
): PenTestResult {
  if (outOfScopeItems.length === 0 || testResult.findings.length === 0) {
    return testResult;
  }

  const { filtered, removedCount } = filterOutOfScopeFindings(
    testResult.findings,
    outOfScopeItems,
    (f) =>
      `${f.category} ${f.description} ${f.recommendation} ${f.file ?? ''}`,
  );

  if (removedCount === 0) return testResult;

  const criticalCount = filtered.filter(
    (f) => f.severity === 'critical',
  ).length;
  const warningCount = filtered.filter(
    (f) => f.severity === 'warning',
  ).length;
  const passed = criticalCount === 0 && warningCount <= maxWarnings;

  logger.log(
    `Architect scope filter removed ${removedCount} security finding(s) as out-of-scope`,
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

// ─── Critical Override ───────────────────────────────────

/**
 * Rule-based override: critical findings always cause a FAIL,
 * regardless of what the LLM decided.
 *
 * Mutates the result in place and returns it for convenience.
 */
export function applyCriticalOverride(
  testResult: PenTestResult,
  logger: Logger,
): PenTestResult {
  const criticalCount = testResult.findings.filter(
    (f) => f.severity === 'critical',
  ).length;
  const warningCount = testResult.findings.filter(
    (f) => f.severity === 'warning',
  ).length;

  if (testResult.passed && criticalCount > 0) {
    logger.warn(
      `Pen Tester LLM said passed but found ${criticalCount} critical + ${warningCount} warning findings — overriding to FAIL`,
    );
    testResult.passed = false;
    testResult.summary = `[OVERRIDE] ${criticalCount} critical finding(s) detected — auto-failed. ${testResult.summary}`;
  }

  return testResult;
}

// ─── Findings → Thread Conversion ────────────────────────

/**
 * Convert SecurityFindings into FindingForThread objects suitable
 * for posting as MR discussion threads.
 */
export function buildFindingsForThreads(
  findings: SecurityFinding[],
): FindingForThread[] {
  const activeFindings = findings.filter((f) => f.severity !== 'info');
  return activeFindings.map((f) => {
    const parts = [
      `**${f.severity.toUpperCase()}** [${f.category}]`,
      '',
      f.description,
    ];
    if (f.file)
      parts.push(
        '',
        `**File:** \`${f.file}${f.line ? `:${f.line}` : ''}\``,
      );
    if (f.expectedFix) parts.push('', `**Expected Fix:** ${f.expectedFix}`);
    if (f.exploitScenario)
      parts.push('', `**Exploit Scenario:** ${f.exploitScenario}`);
    parts.push('', `**Recommendation:** ${f.recommendation}`);
    return {
      severity: f.severity,
      message: `[${f.category}] ${f.description.substring(0, 80)}`,
      file: f.file,
      line: f.line,
      threadBody: parts.join('\n'),
    };
  });
}

// ─── Feedback Text Builder ───────────────────────────────

/**
 * Build structured feedback text from security findings for the
 * coder's fix prompt.
 */
export function buildFailureFeedback(
  findings: SecurityFinding[],
): string {
  const relevantFindings = findings.filter((f) => f.severity !== 'info');
  return relevantFindings
    .map((f, i) => {
      const persist = f.persistsSinceRound
        ? ` (open since round ${f.persistsSinceRound})`
        : '';
      const parts = [
        `${i + 1}. [${f.severity.toUpperCase()}] [${f.category}]${persist}`,
      ];
      parts.push(`   Vulnerability: ${f.description}`);
      if (f.file)
        parts.push(`   File: ${f.file}${f.line ? `:${f.line}` : ''}`);
      if (f.expectedFix) {
        parts.push(`   EXPECTED FIX: ${f.expectedFix}`);
      } else {
        parts.push(`   Fix: ${f.recommendation}`);
      }
      if (f.exploitScenario) parts.push(`   Exploit: ${f.exploitScenario}`);
      return parts.join('\n');
    })
    .join('\n\n');
}
