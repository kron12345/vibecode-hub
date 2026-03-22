/**
 * Parse [CLARIFICATION_NEEDED] markers from LLM responses.
 * Used by agents that support the clarification protocol
 * (Architect, Issue Compiler, Code Reviewer).
 */

export interface ParsedClarification {
  question: string;
  options: string[];
  context: string;
}

const MARKER_START = '[CLARIFICATION_NEEDED]';
const MARKER_END = '[/CLARIFICATION_NEEDED]';

/**
 * Check if an LLM response contains a clarification request.
 */
export function hasClarificationRequest(content: string): boolean {
  return content.includes(MARKER_START) && content.includes(MARKER_END);
}

/**
 * Extract clarification details from LLM response.
 * Returns null if no valid clarification marker found.
 */
export function parseClarificationRequest(
  content: string,
): ParsedClarification | null {
  const startIdx = content.indexOf(MARKER_START);
  const endIdx = content.indexOf(MARKER_END);

  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return null;

  const block = content
    .substring(startIdx + MARKER_START.length, endIdx)
    .trim();

  let question = '';
  const options: string[] = [];
  let context = '';
  let inOptions = false;

  for (const line of block.split('\n')) {
    const trimmed = line.trim();

    if (trimmed.startsWith('Question:')) {
      question = trimmed.substring('Question:'.length).trim();
      inOptions = false;
    } else if (trimmed === 'Options:') {
      inOptions = true;
    } else if (trimmed.startsWith('Context:')) {
      context = trimmed.substring('Context:'.length).trim();
      inOptions = false;
    } else if (inOptions && /^\d+\.\s/.test(trimmed)) {
      options.push(trimmed.replace(/^\d+\.\s*/, ''));
    } else if (inOptions && trimmed.startsWith('-')) {
      options.push(trimmed.replace(/^-\s*/, ''));
    } else if (question && !inOptions && !context && trimmed) {
      // Multi-line question
      question += ' ' + trimmed;
    } else if (context && trimmed) {
      // Multi-line context
      context += ' ' + trimmed;
    }
  }

  if (!question) return null;

  return { question, options, context };
}
