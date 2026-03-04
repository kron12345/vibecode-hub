import { Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GitlabService } from '../gitlab/gitlab.service';
import { CommentAuthorType } from '@prisma/client';

const logger = new Logger('AgentComment');

/** Max chars for comment history injected into LLM prompts */
const MAX_HISTORY_CHARS = 4000;

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
export async function postAgentComment(deps: PostAgentCommentDeps): Promise<void> {
  const {
    prisma, gitlabService, issueId, gitlabProjectId,
    issueIid, agentTaskId, authorName, markdownContent,
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
