import { Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GitlabService } from '../gitlab/gitlab.service';
import { CommentAuthorType } from '@prisma/client';

const logger = new Logger('AgentComment');

/** Max chars for comment history injected into LLM prompts */
const MAX_HISTORY_CHARS = 60000;

export interface PostAgentCommentDeps {
  prisma: PrismaService;
  gitlabService: GitlabService;
  issueId: string;
  gitlabProjectId: number;
  issueIid: number;
  agentTaskId?: string;
  authorName: string;
  markdownContent: string;
}

/**
 * Unified comment posting: saves to local DB + GitLab Issue Note.
 * The SAME rich markdown is stored in both places.
 * If GitLab fails → still saves locally (graceful degradation).
 */
export async function postAgentComment(
  deps: PostAgentCommentDeps,
): Promise<void> {
  const {
    prisma,
    gitlabService,
    issueId,
    gitlabProjectId,
    issueIid,
    agentTaskId,
    authorName,
    markdownContent,
  } = deps;

  let gitlabNoteId: number | undefined;

  // 1. Post to GitLab
  try {
    const note = await gitlabService.createIssueNote(
      gitlabProjectId,
      issueIid,
      markdownContent,
    );
    gitlabNoteId = note.id;
  } catch (err) {
    logger.warn(`GitLab comment failed for ${authorName}: ${err.message}`);
  }

  // 2. Save locally with the SAME markdown + gitlabNoteId
  try {
    await prisma.issueComment.create({
      data: {
        issueId,
        authorType: CommentAuthorType.AGENT,
        authorName,
        content: markdownContent,
        gitlabNoteId: gitlabNoteId ?? null,
        agentTaskId: agentTaskId ?? null,
      },
    });
  } catch (err) {
    logger.error(`Local comment save failed for ${authorName}: ${err.message}`);
  }
}

export interface GetAgentCommentHistoryDeps {
  prisma: PrismaService;
  issueId: string;
}

/**
 * Loads all agent comments for an issue, formatted as a conversation
 * string for LLM prompt injection.
 *
 * Returns empty string if no comments exist.
 * Truncates to ~4000 chars to avoid overloading LLM context.
 */
export async function getAgentCommentHistory(
  deps: GetAgentCommentHistoryDeps,
): Promise<string> {
  const { prisma, issueId } = deps;

  const comments = await prisma.issueComment.findMany({
    where: {
      issueId,
      authorType: CommentAuthorType.AGENT,
    },
    orderBy: { createdAt: 'asc' },
    select: {
      authorName: true,
      content: true,
      createdAt: true,
    },
  });

  if (comments.length === 0) return '';

  let result = '';
  for (const c of comments) {
    const entry = `[${c.authorName}]:\n${c.content}\n\n`;

    if (result.length + entry.length > MAX_HISTORY_CHARS) {
      result += `... (${comments.length - comments.indexOf(c)} more comment(s) truncated)\n`;
      break;
    }

    result += entry;
  }

  return result.trim();
}

/**
 * Extract the LAST set of findings from a specific agent's comments in the comment history.
 * Returns structured finding objects for injection into re-evaluation prompts.
 * Only returns findings from the agent's MOST RECENT comment — not the full history.
 */
export function extractLastAgentFindings(
  commentHistory: string | null,
  agentName: 'Code Reviewer' | 'Functional Tester' | 'UI Tester' | 'Pen Tester',
): Array<{
  severity?: string;
  file?: string;
  message: string;
  suggestion?: string;
  expectedFix?: string;
  criterion?: string;
  status?: string;
}> {
  if (!commentHistory) return [];

  // Find the last comment block from this specific agent
  // Agent comments are formatted as "## <emoji> <AgentName>: <STATUS>" or "---\n_Reviewed by <AgentName> Agent_"
  const agentMarkers: Record<string, RegExp> = {
    'Code Reviewer': /## [✅⚠️❌]+ Code Review:/g,
    'Functional Tester': /## [✅⚠️❌]+ Functional Test:/g,
    'UI Tester': /## [✅⚠️❌]+ UI Test:/g,
    'Pen Tester': /## [✅⚠️❌]+ Security Test:/g,
  };

  const marker = agentMarkers[agentName];
  if (!marker) return [];

  // Find all positions of this agent's comments
  const matches = [...commentHistory.matchAll(marker)];
  if (matches.length === 0) return [];

  // Get the LAST comment block
  const lastMatch = matches[matches.length - 1];
  const startPos = lastMatch.index;

  // Find the end of this comment block (next agent comment or end of string)
  const allAgentPattern =
    /## [✅⚠️❌]+ (?:Code Review|Functional Test|UI Test|Security Test):/g;
  allAgentPattern.lastIndex = startPos + lastMatch[0].length;
  const nextAgent = allAgentPattern.exec(commentHistory);
  const endPos = nextAgent ? nextAgent.index : commentHistory.length;

  const lastComment = commentHistory.substring(startPos, endPos);

  // Extract findings from the markdown
  // Findings are formatted as:
  // 🔴/🟡/🔵 **severity** — `file:line`
  //   message
  //   💡 suggestion
  // OR for functional tester:
  // ✅/❌ **criterion**
  //   details
  const findings: Array<{
    severity?: string;
    file?: string;
    message: string;
    suggestion?: string;
    expectedFix?: string;
    criterion?: string;
    status?: string;
  }> = [];

  // Pattern 1: Old format — code reviewer / pen tester findings (inline markdown)
  // 🔴 **severity** — `file:line`\n  message\n  💡 suggestion
  const reviewFindingPattern =
    /[🔴🟡🔵]\s+\*\*(\w+)\*\*\s+[—–-]\s+`([^`]+)`\s*\n\s+(.+?)(?:\n\s+💡\s+(.+?))?(?=\n[🔴🟡🔵]|\n---|\n\n|\n##|$)/gs;
  let match: RegExpExecArray | null;
  while ((match = reviewFindingPattern.exec(lastComment)) !== null) {
    findings.push({
      severity: match[1].toLowerCase(),
      file: match[2],
      message: match[3].trim(),
      suggestion: match[4]?.trim(),
    });
  }

  // Pattern 2: New format — MR discussion thread links
  // - 🔴 [message text](thread_url)
  const threadLinkPattern = /- [🔴🟡🔵]\s+\[(.+?)\]\(([^)]+)\)/g;
  while ((match = threadLinkPattern.exec(lastComment)) !== null) {
    // Only add if not already captured by pattern 1 (avoid duplicates)
    const msg = match[1].trim();
    if (!findings.some((f) => f.message === msg)) {
      findings.push({
        message: msg,
        severity:
          lastComment.charAt(match.index + 2) === '🔴'
            ? 'critical'
            : lastComment.charAt(match.index + 2) === '🟡'
              ? 'warning'
              : 'info',
      });
    }
  }

  // Pattern 3: Functional tester findings (old format)
  // ✅/❌ **criterion**\n  details
  const funcFindingPattern =
    /[✅❌]\s+\*\*(.+?)\*\*\s*\n\s+(.+?)(?=\n[✅❌]|\n---|\n\n|\n##|$)/gs;
  while ((match = funcFindingPattern.exec(lastComment)) !== null) {
    findings.push({
      criterion: match[1].trim(),
      message: match[2].trim(),
    });
  }

  return findings;
}
