const OUT_OF_SCOPE_PATTERN =
  /\b(out\s*of\s*scope|outside\s+(?:the\s+)?scope|not\s+in\s+scope|not\s+required|won't\s+fix|ignore\s+for\s+this\s+issue|nicht\s+im\s+scope|au(?:ss|\u00DF)erhalb\s+des\s+scopes|nicht\s+relevant)\b/i;

const OUT_OF_SCOPE_HEADING_PATTERN =
  /^(#{1,6}\s*)?(out\s*of\s*scope|not\s+in\s+scope|excluded|exclusions|nicht\s+im\s+scope|au(?:ss|\u00DF)erhalb\s+des\s+scopes)\s*:?\s*$/i;

const MAX_SCOPE_ITEMS = 20;
const MAX_SCOPE_ITEM_LENGTH = 220;

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'that',
  'this',
  'these',
  'those',
  'should',
  'must',
  'not',
  'are',
  'is',
  'was',
  'were',
  'will',
  'can',
  'could',
  'would',
  'und',
  'oder',
  'mit',
  'von',
  'ist',
  'sind',
  'dass',
  'dies',
  'diese',
  'dieser',
  'issue',
  'ticket',
  'task',
  'scope',
  'out',
  'of',
  'in',
  'to',
  'on',
  'at',
  'as',
]);

interface AgentCommentBlock {
  author: string;
  content: string;
}

function parseAgentCommentBlocks(commentHistory: string): AgentCommentBlock[] {
  if (!commentHistory.trim()) return [];

  const blocks: AgentCommentBlock[] = [];
  const pattern = /\[([^\]]+)\]:\n([\s\S]*?)(?=\n\[[^\]]+\]:\n|$)/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(commentHistory)) !== null) {
    blocks.push({
      author: match[1].trim(),
      content: match[2].trim(),
    });
  }

  return blocks;
}

function normalizeLine(line: string): string {
  return line
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+\.\s+/, '')
    .replace(/`/g, '')
    .replace(/\*\*/g, '')
    .replace(/__/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_#>"'.,:;()[\]{}!?/\\|-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(text: string): Set<string> {
  const tokens = normalizeText(text)
    .split(' ')
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t));
  return new Set(tokens);
}

function intersectsOutOfScopeRule(findingText: string, rule: string): boolean {
  const normalizedFinding = normalizeText(findingText);
  const normalizedRule = normalizeText(rule);

  if (!normalizedFinding || !normalizedRule) return false;

  if (normalizedRule.length >= 12 && normalizedFinding.includes(normalizedRule))
    return true;

  const findingTokens = tokenize(normalizedFinding);
  const ruleTokens = tokenize(normalizedRule);
  if (findingTokens.size === 0 || ruleTokens.size === 0) return false;

  let intersectCount = 0;
  for (const token of ruleTokens) {
    if (findingTokens.has(token)) intersectCount++;
  }

  if (intersectCount >= 3) return true;

  const overlap =
    intersectCount / Math.max(1, Math.min(ruleTokens.size, findingTokens.size));
  return intersectCount >= 2 && overlap >= 0.6;
}

export function extractArchitectOutOfScopeItems(
  commentHistory: string,
): string[] {
  const blocks = parseAgentCommentBlocks(commentHistory);
  const architectBlocks = blocks.filter((b) => /architect/i.test(b.author));
  if (architectBlocks.length === 0) return [];

  const items: string[] = [];

  for (const block of architectBlocks) {
    let inOutOfScopeSection = false;
    const lines = block.content.split('\n');

    for (const rawLine of lines) {
      const line = normalizeLine(rawLine);
      if (!line || line === '---') continue;

      if (/^#{1,6}\s+/.test(line)) {
        inOutOfScopeSection = OUT_OF_SCOPE_HEADING_PATTERN.test(line);
        continue;
      }

      if (OUT_OF_SCOPE_HEADING_PATTERN.test(line)) {
        inOutOfScopeSection = true;
        continue;
      }

      if (inOutOfScopeSection && /^#{1,6}\s+/.test(rawLine.trim())) {
        inOutOfScopeSection = false;
      }

      if (OUT_OF_SCOPE_PATTERN.test(line) || inOutOfScopeSection) {
        const cleaned = line
          .replace(OUT_OF_SCOPE_PATTERN, '')
          .replace(/^[:\-]\s*/, '')
          .trim();

        const candidate = cleaned.length >= 5 ? cleaned : line;
        if (candidate.length <= MAX_SCOPE_ITEM_LENGTH) {
          items.push(candidate);
        } else {
          items.push(candidate.substring(0, MAX_SCOPE_ITEM_LENGTH).trim());
        }
      }
    }
  }

  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const key = normalizeText(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
    if (deduped.length >= MAX_SCOPE_ITEMS) break;
  }

  return deduped;
}

export function buildArchitectScopeGuardSection(
  outOfScopeItems: string[],
): string {
  if (outOfScopeItems.length === 0) return '';

  const listed = outOfScopeItems
    .slice(0, MAX_SCOPE_ITEMS)
    .map((item) => `- ${item}`)
    .join('\n');

  return [
    '## Architect Scope Guard (MUST FOLLOW)',
    'The Architect marked the following as OUT OF SCOPE for this issue.',
    'Do NOT report these points as defects/findings. Ignore them unless they block an in-scope requirement.',
    listed,
  ].join('\n');
}

export function filterOutOfScopeFindings<T>(
  findings: T[],
  outOfScopeItems: string[],
  getFindingText: (finding: T) => string,
): { filtered: T[]; removedCount: number } {
  if (findings.length === 0 || outOfScopeItems.length === 0) {
    return { filtered: findings, removedCount: 0 };
  }

  const filtered: T[] = [];
  let removedCount = 0;

  for (const finding of findings) {
    const text = getFindingText(finding);
    const normalized = normalizeText(text);

    const explicitOutOfScope = OUT_OF_SCOPE_PATTERN.test(normalized);
    const matchesArchitectRule = outOfScopeItems.some((rule) =>
      intersectsOutOfScopeRule(text, rule),
    );

    if (explicitOutOfScope || matchesArchitectRule) {
      removedCount++;
      continue;
    }

    filtered.push(finding);
  }

  return { filtered, removedCount };
}
