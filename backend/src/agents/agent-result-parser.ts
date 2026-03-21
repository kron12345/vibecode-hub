/**
 * Shared result-parsing utilities for all testing/review agents.
 * Eliminates ~400 lines of duplicated JSON extraction logic across
 * functional-tester, ui-tester, pen-tester, and code-reviewer.
 */

/** Strip <think> reasoning tags from LLM output */
export function stripThinkTags(content: string): string {
  return content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

/** Fix common JSON issues: trailing commas, control characters */
export function cleanJsonString(jsonStr: string): string {
  return jsonStr
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/[\x00-\x1F\x7F]/g, ' ');
}

/** Strip code fences and extract the first JSON object from a string */
export function findJsonObject(str: string): string | null {
  const stripped = str
    .replace(/^```(?:json)?\s*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .trim();
  const match = stripped.match(/\{[\s\S]*\}/);
  return match ? match[0] : null;
}

/**
 * Extract JSON from LLM response using 4 strategies:
 * 1. After completion marker (if provided)
 * 2. Code fence extraction
 * 3. Last JSON object with key indicator (validated)
 * 4. Greedy match with key indicator (validated)
 *
 * @param content    Raw LLM response
 * @param marker     Optional completion marker string
 * @param keyIndicator  JSON key to look for (default: "passed")
 */
export function extractJson(
  content: string,
  marker?: string,
  keyIndicator = 'passed',
): string | null {
  // Strategy 1: After completion marker
  if (marker && content.includes(marker)) {
    const after = content
      .substring(content.indexOf(marker) + marker.length)
      .trim();
    const json = findJsonObject(after);
    if (json) return json;
  }

  // Strategy 2: Code fence
  const fenceMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    const json = findJsonObject(fenceMatch[1]);
    if (json) return json;
  }

  // Strategy 3: Last JSON with key indicator — validate parseable
  const allJson = [...content.matchAll(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g)];
  for (let i = allJson.length - 1; i >= 0; i--) {
    const candidate = allJson[i][0];
    if (
      candidate.includes(`"${keyIndicator}"`) ||
      candidate.includes('"findings"')
    ) {
      try {
        JSON.parse(candidate);
        return candidate;
      } catch {
        continue;
      }
    }
  }

  // Strategy 4: Greedy match with key indicator — validate
  const greedy = content.match(
    new RegExp(`\\{[\\s\\S]*"${keyIndicator}"[\\s\\S]*\\}`),
  );
  if (greedy) {
    try {
      JSON.parse(greedy[0]);
      return greedy[0];
    } catch {
      /* skip */
    }
  }

  return null;
}

/** Normalize LLM verdict (passed/status/result) to boolean */
export function normalizePass(parsed: any): boolean {
  if (typeof parsed.passed === 'boolean') return parsed.passed;
  if (typeof parsed.passed === 'string')
    return parsed.passed.toLowerCase() === 'true';
  if (parsed.status) {
    const s = String(parsed.status).toLowerCase();
    return (
      s === 'pass' ||
      s === 'passed' ||
      s === 'success' ||
      s === 'secure'
    );
  }
  if (parsed.result) {
    const r = String(parsed.result).toLowerCase();
    return (
      r === 'pass' ||
      r === 'passed' ||
      r === 'success' ||
      r === 'secure'
    );
  }
  return false;
}

/** Normalize review approval verdict to boolean */
export function normalizeApproval(parsed: any): boolean {
  if (typeof parsed.approved === 'boolean') return parsed.approved;
  if (typeof parsed.approved === 'string')
    return parsed.approved.toLowerCase() === 'true';
  if (parsed.decision) {
    const d = String(parsed.decision).toLowerCase();
    return d === 'approve' || d === 'approved' || d === 'pass';
  }
  if (parsed.verdict) {
    const v = String(parsed.verdict).toLowerCase();
    return v === 'approve' || v === 'approved' || v === 'pass';
  }
  return false;
}

/** Normalize severity string to standard levels */
export function normalizeSeverity(
  raw: any,
): 'info' | 'warning' | 'critical' {
  const s = String(raw ?? 'info').toLowerCase().trim();
  if (s === 'critical' || s === 'error' || s === 'high' || s === 'blocker')
    return 'critical';
  if (
    s === 'warning' ||
    s === 'warn' ||
    s === 'medium' ||
    s === 'moderate' ||
    s === 'major'
  )
    return 'warning';
  return 'info';
}

/**
 * Format MR diffs for inclusion in an agent prompt.
 * Truncates individual diffs and limits total count.
 */
export function formatDiffsForPrompt(
  diffs: Array<{
    new_path: string;
    old_path?: string;
    diff: string;
    new_file?: boolean;
    deleted_file?: boolean;
    renamed_file?: boolean;
  }>,
  maxDiffChars = 20_000,
): string {
  return diffs
    .map((d) => {
      const prefix = d.new_file
        ? '[NEW]'
        : d.deleted_file
          ? '[DELETED]'
          : d.renamed_file
            ? '[RENAMED]'
            : '[MODIFIED]';
      const truncated =
        d.diff.length > maxDiffChars
          ? d.diff.substring(0, maxDiffChars) + '\n... (truncated)'
          : d.diff;
      return `### ${prefix} ${d.new_path}\n\`\`\`diff\n${truncated}\n\`\`\``;
    })
    .join('\n\n');
}
