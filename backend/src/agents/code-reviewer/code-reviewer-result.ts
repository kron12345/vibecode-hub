import { Logger } from '@nestjs/common';
import {
  stripThinkTags,
  cleanJsonString,
  extractJson,
  normalizeApproval,
  normalizeSeverity,
} from '../agent-result-parser';
import { filterOutOfScopeFindings } from '../agent-scope.utils';
import { ReviewResult, ReviewFinding } from './review-result.interface';

/** Marker the LLM emits when review is done */
export const COMPLETION_MARKER = ':::REVIEW_COMPLETE:::';

const logger = new Logger('CodeReviewerResult');

/**
 * Parse findings array with validation.
 * Handles multiple formats: findings, issues, comments, problems.
 */
export function parseFindings(rawFindings: any): ReviewFinding[] {
  if (!Array.isArray(rawFindings)) return [];
  const result = rawFindings
    .filter((f: any) => f && typeof f === 'object')
    .map((f: any) => ({
      severity: normalizeSeverity(f.severity || f.type || f.level),
      file: String(f.file ?? f.path ?? f.filename ?? 'unknown'),
      line:
        typeof f.line === 'number'
          ? f.line
          : typeof f.lineNumber === 'number'
            ? f.lineNumber
            : undefined,
      message: String(
        f.message ?? f.description ?? f.comment ?? f.text ?? 'No details',
      ),
      suggestion: f.suggestion
        ? String(f.suggestion)
        : f.suggestedFix
          ? String(f.suggestedFix)
          : undefined,
      expectedFix: f.expectedFix ? String(f.expectedFix) : undefined,
      firstReportedRound:
        typeof f.firstReportedRound === 'number'
          ? f.firstReportedRound
          : undefined,
      status: ['new', 'resolved', 'unresolved', 'blocked'].includes(f.status)
        ? f.status
        : undefined,
    }));

  // Post-validation: detect field-mixing (expectedFix text in message field)
  for (const finding of result) {
    if (
      finding.message &&
      /^(Erwarteter Fix|Expected Fix|Fix:|Suggestion:|Empfehlung:)/i.test(
        finding.message,
      )
    ) {
      // Move the fix text to expectedFix if not already set
      if (!finding.expectedFix) {
        finding.expectedFix = finding.message;
      }
      // Try to use suggestion as the real message, or mark as needs-detail
      finding.message =
        finding.suggestion ??
        `Finding in ${finding.file}${finding.line ? `:${finding.line}` : ''} (see expectedFix for details)`;
    }
  }

  return result;
}

/**
 * Extract a summary sentence from the review text.
 */
export function extractSummaryFromText(text: string): string | null {
  // Look for explicit summary section
  const summaryMatch = text.match(
    /(?:summary|decision|conclusion|overall)[:\s]*\n?\s*(.+?)(?:\n\n|\n(?=[#*\-]))/i,
  );
  if (summaryMatch) {
    const cleaned = summaryMatch[1].replace(/^\*+\s*|\s*\*+$/g, '').trim();
    if (cleaned.length > 10) return cleaned.substring(0, 200);
  }

  // Look for the first substantial paragraph (skip headers like "**Review Analysis:**")
  const markerPos = text.indexOf(COMPLETION_MARKER);
  const beforeMarker = markerPos > 0 ? text.substring(0, markerPos) : text;

  // Split into paragraphs and find the first meaningful one
  const paragraphs = beforeMarker
    .split(/\n\n+/)
    .map((p) =>
      p
        .replace(/^\*+\s*|\s*\*+$/g, '')
        .replace(/^#+\s*/, '')
        .trim(),
    )
    .filter(
      (p) => p.length > 30 && !p.startsWith('###') && !p.startsWith('---'),
    );

  if (paragraphs.length > 0) {
    // Use the first real paragraph as summary
    const first = paragraphs[0].split('\n')[0]; // Just the first line
    return first.substring(0, 200);
  }

  // Last resort: last sentence before JSON
  const sentences = beforeMarker
    .split(/[.\n]/)
    .filter((s) => s.trim().length > 20);
  if (sentences.length > 0) {
    return sentences[sentences.length - 1]
      .replace(/^\*+\s*|\s*\*+$/g, '')
      .trim()
      .substring(0, 200);
  }
  return null;
}

/**
 * Fallback: analyze the review text to determine approval/findings
 * when JSON parsing fails completely.
 */
export function buildResultFromText(
  text: string,
  issueId: string,
  mrIid: number,
): ReviewResult {
  const lower = text.toLowerCase();

  // Determine approval from text keywords
  const hasChangesRequested =
    lower.includes('request changes') ||
    lower.includes('changes requested') ||
    lower.includes('changes_required') ||
    lower.includes('not approved') ||
    lower.includes('reject');

  const hasApproved =
    lower.includes('approved') ||
    lower.includes('approve') ||
    lower.includes('lgtm') ||
    lower.includes('looks good');

  // Count severity mentions as proxy findings
  const criticalCount = (lower.match(/critical/g) || []).length;
  const warningCount = (lower.match(/warning/g) || []).length;

  // Extract the first paragraph after any "summary" keyword as the summary
  const summary =
    extractSummaryFromText(text) ||
    'Review analysis completed (parsed from text)';

  // Build synthetic findings from text analysis
  const findings: ReviewFinding[] = [];
  const findingPattern =
    /(?:^|\n)\s*(?:\d+\.\s*)?(?:\*\*)?(?:(?:critical|warning|info)[:\s\u2014-]+)(.*?)(?:\n|$)/gi;
  let match: RegExpExecArray | null;
  while ((match = findingPattern.exec(text)) !== null) {
    const line = match[0].trim();
    const severity = /critical/i.test(line)
      ? 'critical'
      : /warning/i.test(line)
        ? 'warning'
        : 'info';
    findings.push({
      severity,
      file: 'unknown',
      message: match[1]?.trim() || line.substring(0, 100),
    });
  }

  // Apply decision rules: no critical findings AND <=2 warnings -> approve
  // This prevents false rejections when the LLM doesn't output clear keywords
  const criticalFindings = findings.filter((f) => f.severity === 'critical');
  const warningFindings = findings.filter((f) => f.severity === 'warning');
  const ruleBasedApproval =
    criticalFindings.length === 0 && warningFindings.length <= 2;

  // Use rule-based approval but let explicit rejection override if findings back it up
  const approved = ruleBasedApproval || (hasApproved && !hasChangesRequested);

  logger.log(
    `Text-based review: approved=${approved} (rule=${ruleBasedApproval}, keywords: approve=${hasApproved}, reject=${hasChangesRequested}), criticals=${criticalCount}, warnings=${warningCount}, findings=${findings.length}`,
  );

  return { issueId, mrIid, approved, summary, findings };
}

/**
 * Repair "No details" findings by extracting info from the summary or raw text.
 * Some LLMs (gpt-5.3-codex) put finding details in summary instead of finding objects.
 */
function repairNoDetailFindings(
  findings: ReviewFinding[],
  summary: string | undefined,
  cleaned: string,
): void {
  const noDetailFindings = findings.filter((f) => f.message === 'No details');
  if (noDetailFindings.length === 0) return;

  // Strategy 1: Parse numbered items from summary
  if (summary && summary.length > 20) {
    const summaryItems =
      summary.match(
        /\d+\.\s*[🔴🟡🔵⚠️]?\s*\*?\*?(?:critical|warning|info)?:?\*?\*?\s*(.+?)(?=\d+\.\s*[🔴🟡🔵⚠️]|$)/gi,
      ) || [];
    for (
      let i = 0;
      i < noDetailFindings.length && i < summaryItems.length;
      i++
    ) {
      const item = summaryItems[i]
        .replace(
          /^\d+\.\s*[🔴🟡🔵⚠️]?\s*\*?\*?(?:critical|warning|info)?:?\*?\*?\s*/i,
          '',
        )
        .trim();
      if (item.length > 5) {
        noDetailFindings[i].message = item.substring(0, 300);
        logger.debug(
          `Repaired "No details" finding ${i + 1} from summary: ${item.substring(0, 80)}`,
        );
      }
    }
  }

  // Strategy 2: Try extracting from the raw text before the JSON
  const stillEmpty = findings.filter((f) => f.message === 'No details');
  if (stillEmpty.length > 0) {
    const markerPos = cleaned.indexOf(COMPLETION_MARKER);
    const beforeJson =
      markerPos > 0
        ? cleaned.substring(0, markerPos)
        : cleaned.substring(0, cleaned.lastIndexOf('{'));
    if (beforeJson.length > 50) {
      const detailLines =
        beforeJson.match(
          /(?:^|\n)\s*(?:\d+\.\s*)?(?:[🔴🟡🔵]\s*)?(?:\*\*(?:critical|warning|info)\*\*[:\s\u2014\u2013-]*)?(.{10,200}?)(?=\n\s*(?:\d+\.|\*\*|[🔴🟡🔵]|$))/gim,
        ) || [];
      const cleanLines = detailLines
        .map((l) =>
          l
            .replace(/^\s*\d+\.\s*/, '')
            .replace(/[🔴🟡🔵]\s*/, '')
            .replace(/\*\*/g, '')
            .trim(),
        )
        .filter(
          (l) =>
            l.length > 10 && !l.startsWith('```') && !l.startsWith('##'),
        );
      for (let i = 0; i < stillEmpty.length && i < cleanLines.length; i++) {
        stillEmpty[i].message = cleanLines[i].substring(0, 300);
        logger.debug(
          `Repaired "No details" finding ${i + 1} from raw text: ${cleanLines[i].substring(0, 80)}`,
        );
      }
    }
  }
}

/**
 * Parse a complete review result from LLM output.
 * Handles JSON extraction, normalization, finding repair, and rule-based approval.
 */
export function parseReviewResult(
  content: string,
  issueId: string,
  mrIid: number,
): ReviewResult | null {
  logger.debug(`Parsing review result (${content.length} chars)`);

  if (!content.trim()) {
    logger.error('Review content is empty — LLM returned nothing');
    return null;
  }

  // Step 1: Strip <think> tags
  const cleaned = stripThinkTags(content);

  if (cleaned.length !== content.length) {
    logger.debug(
      `Stripped <think> tags: ${content.length} → ${cleaned.length} chars`,
    );
  }

  // Step 2: Try to extract JSON after the completion marker
  let jsonStr = extractJson(cleaned, COMPLETION_MARKER, 'approved');

  if (!jsonStr) {
    logger.warn(
      'Could not extract JSON from review — attempting text-based analysis',
    );
    return buildResultFromText(cleaned, issueId, mrIid);
  }

  try {
    // Fix common JSON issues
    jsonStr = cleanJsonString(jsonStr);

    const parsed = JSON.parse(jsonStr);

    // Normalize different JSON formats
    const approved = normalizeApproval(parsed);
    const findings = parseFindings(
      parsed.findings ||
        parsed.issues ||
        parsed.comments ||
        parsed.problems ||
        [],
    );

    // Build summary
    let summary = parsed.summary || extractSummaryFromText(cleaned);
    if (summary) {
      summary = summary
        .replace(
          /^[:\s]*(?:CHANGES_REQUIRED|APPROVED|CHANGES REQUESTED)[:\s]*/i,
          '',
        )
        .trim();
    }
    if (!summary || summary.length < 5) {
      summary = approved
        ? 'Code review passed'
        : `Changes requested (${findings.length} finding(s))`;
    }

    // Repair "No details" findings
    repairNoDetailFindings(findings, summary, cleaned);

    // Strategy 3: If ALL findings are STILL "No details" after repair,
    // the review output is unusable — treat as parse failure, NOT auto-approve
    const finallyEmpty = findings.filter((f) => f.message === 'No details');
    if (finallyEmpty.length === findings.length && findings.length > 0) {
      logger.warn(
        `All ${findings.length} findings have "No details" after repair attempts — treating as parse failure`,
      );
      return buildResultFromText(cleaned, issueId, mrIid);
    }

    // Apply decision rules — don't blindly trust LLM's "approved" field
    const criticalFindings = findings.filter(
      (f) => f.severity === 'critical',
    );
    const warningFindings = findings.filter((f) => f.severity === 'warning');
    const ruleBasedApproval =
      criticalFindings.length === 0 && warningFindings.length <= 2;

    if (ruleBasedApproval !== approved) {
      logger.warn(
        `Overriding LLM approval (${approved}) → ${ruleBasedApproval} based on decision rules: ` +
          `${criticalFindings.length} critical, ${warningFindings.length} warnings, ${findings.length} total findings`,
      );
    }

    // Extract Expectation Pattern metadata
    const roundNumber =
      typeof parsed.roundNumber === 'number' ? parsed.roundNumber : undefined;
    const resolvedFromPrevious = Array.isArray(parsed.resolvedFromPrevious)
      ? parsed.resolvedFromPrevious
          .filter((r: any) => r && typeof r === 'object' && r.message)
          .map((r: any) => ({
            message: String(r.message),
            resolvedBy: String(r.resolvedBy ?? ''),
          }))
      : undefined;

    const result: ReviewResult = {
      issueId,
      mrIid,
      approved: ruleBasedApproval,
      summary,
      findings,
      roundNumber,
      resolvedFromPrevious,
    };

    logger.log(
      `Parsed review: approved=${result.approved}, findings=${result.findings.length} (${criticalFindings.length}C/${warningFindings.length}W), summary="${result.summary.substring(0, 80)}"`,
    );
    return result;
  } catch (err) {
    logger.error(
      `JSON parse failed: ${err.message} — raw JSON: ${jsonStr.substring(0, 200)}`,
    );
    return buildResultFromText(cleaned, issueId, mrIid);
  }
}

/**
 * Filter review findings using Architect out-of-scope constraints.
 * Re-calculates approval based on remaining findings.
 */
export function applyArchitectScopeFilter(
  reviewResult: ReviewResult,
  outOfScopeItems: string[],
): ReviewResult {
  if (outOfScopeItems.length === 0 || reviewResult.findings.length === 0) {
    return reviewResult;
  }

  const { filtered, removedCount } = filterOutOfScopeFindings(
    reviewResult.findings,
    outOfScopeItems,
    (f) => `${f.file} ${f.message} ${f.suggestion ?? ''}`,
  );

  if (removedCount === 0) return reviewResult;

  const criticalCount = filtered.filter(
    (f) => f.severity === 'critical',
  ).length;
  const warningCount = filtered.filter(
    (f) => f.severity === 'warning',
  ).length;
  const approved = criticalCount === 0 && warningCount <= 2;

  logger.log(
    `Architect scope filter removed ${removedCount} review finding(s) as out-of-scope`,
  );

  const summarySuffix = `Architect scope filter ignored ${removedCount} out-of-scope finding(s).`;
  const summary = reviewResult.summary
    ? `${reviewResult.summary} ${summarySuffix}`
    : summarySuffix;

  return {
    ...reviewResult,
    approved,
    findings: filtered,
    summary,
  };
}
