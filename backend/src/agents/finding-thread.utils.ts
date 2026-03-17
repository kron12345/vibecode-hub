import { Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { AgentRole, FindingThread } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { GitlabService, MrDiscussionPosition } from '../gitlab/gitlab.service';

const logger = new Logger('FindingThread');

// ─── Interfaces ────────────────────────────────────────────────

export interface FindingForThread {
  severity: string;
  message: string;
  file?: string;
  line?: number;
  /** Full markdown body for the thread (including expected fix, etc.) */
  threadBody: string;
}

export interface PostFindingsAsThreadsDeps {
  prisma: PrismaService;
  gitlabService: GitlabService;
  issueId: string;
  mrIid: number;
  gitlabProjectId: number;
  agentRole: AgentRole;
  roundNumber: number;
  findings: FindingForThread[];
}

// ─── Helpers ───────────────────────────────────────────────────

const SEVERITY_ICONS: Record<string, string> = {
  critical: '\uD83D\uDD34', // red circle
  warning: '\uD83D\uDFE1', // yellow circle
  info: '\uD83D\uDD35', // blue circle
};

function severityIcon(severity: string): string {
  return SEVERITY_ICONS[severity.toLowerCase()] ?? '\u26AA'; // white circle fallback
}

/**
 * Generate a stable fingerprint from severity + file + message.
 * Uses first 60 chars lowercased/trimmed, hashed to a short hex string.
 */
function generateFingerprint(
  severity: string,
  file: string | undefined,
  message: string,
  line?: number,
): string {
  const raw = `${severity}:${file ?? ''}:${line ?? ''}:${message}`
    .toLowerCase()
    .trim()
    .substring(0, 100);
  return createHash('sha256').update(raw).digest('hex').substring(0, 16);
}

/** Re-export for agents that need to compute fingerprints for dedup checks */
export { generateFingerprint };

// ─── postFindingsAsThreads ────────────────────────────────────

/**
 * Post each finding as a GitLab MR discussion thread and persist
 * the mapping in the local FindingThread table.
 *
 * - Attempts diff-bound threads when file/line/diff_refs are available;
 *   falls back to a general thread if GitLab rejects the position.
 * - Each thread is wrapped in try/catch so one failure doesn't block the rest.
 */
export async function postFindingsAsThreads(
  deps: PostFindingsAsThreadsDeps,
): Promise<FindingThread[]> {
  const {
    prisma,
    gitlabService,
    issueId,
    mrIid,
    gitlabProjectId,
    agentRole,
    roundNumber,
    findings,
  } = deps;

  // Filter out empty/broken findings that would create useless threads
  const validFindings = findings.filter(f => {
    if (!f.message || f.message === 'No details' || f.message.trim().length < 5) {
      logger.warn(`Skipping empty/broken finding: [${f.severity}] "${f.message}" — not posting as thread`);
      return false;
    }
    return true;
  });

  if (validFindings.length === 0) return [];

  // Fetch MR for web_url and diff_refs
  let mrWebUrl: string;
  let diffRefs:
    | { base_sha: string; head_sha: string; start_sha: string }
    | undefined;

  try {
    const mr = await gitlabService.getMergeRequest(gitlabProjectId, mrIid);
    mrWebUrl = mr.web_url;
    diffRefs = mr.diff_refs;
  } catch (err) {
    logger.error(
      `Failed to fetch MR !${mrIid} in project ${gitlabProjectId}: ${err.message}`,
    );
    return [];
  }

  const created: FindingThread[] = [];

  for (const finding of validFindings) {
    try {
      const fingerprint = generateFingerprint(
        finding.severity,
        finding.file,
        finding.message,
        finding.line,
      );

      // Build thread body with hidden metadata comment
      const body = [
        `<!-- vch-agent:${agentRole} round:${roundNumber} fingerprint:${fingerprint} -->`,
        '',
        finding.threadBody,
      ].join('\n');

      // Try diff-bound thread first, fall back to general thread
      let discussion: Awaited<
        ReturnType<typeof gitlabService.createMrDiscussion>
      >;

      if (finding.file && finding.line && diffRefs) {
        const position: MrDiscussionPosition = {
          position_type: 'text',
          base_sha: diffRefs.base_sha,
          head_sha: diffRefs.head_sha,
          start_sha: diffRefs.start_sha,
          old_path: finding.file,
          new_path: finding.file,
          new_line: finding.line,
        };

        try {
          discussion = await gitlabService.createMrDiscussion(
            gitlabProjectId,
            mrIid,
            body,
            position,
          );
        } catch {
          // Line not in diff or other position error — fall back to general thread
          logger.debug(
            `Diff-bound thread failed for ${finding.file}:${finding.line}, falling back to general thread`,
          );
          discussion = await gitlabService.createMrDiscussion(
            gitlabProjectId,
            mrIid,
            body,
          );
        }
      } else {
        discussion = await gitlabService.createMrDiscussion(
          gitlabProjectId,
          mrIid,
          body,
        );
      }

      const rootNoteId = discussion.notes?.[0]?.id;
      if (!rootNoteId) {
        logger.warn(
          `Discussion created but no root note ID returned — skipping DB save`,
        );
        continue;
      }
      const threadUrl = `${mrWebUrl}#note_${rootNoteId}`;

      const record = await prisma.findingThread.create({
        data: {
          issueId,
          mrIid,
          agentRole,
          discussionId: discussion.id,
          rootNoteId: rootNoteId ?? 0,
          threadUrl,
          fingerprint,
          severity: finding.severity.toLowerCase(),
          message: finding.message,
          resolved: false,
          roundNumber,
        },
      });

      created.push(record);
    } catch (err) {
      logger.error(
        `Failed to post finding thread for [${finding.severity}] ${finding.message.substring(0, 80)}: ${err.message}`,
      );
    }
  }

  logger.log(
    `Posted ${created.length}/${findings.length} finding threads on MR !${mrIid} (${agentRole}, round ${roundNumber})`,
  );
  return created;
}

// ─── getUnresolvedThreads ─────────────────────────────────────

/**
 * Query local DB for unresolved FindingThreads for a given issue, MR, and agent role.
 * Returns the local state without syncing with GitLab (keep it simple for now).
 */
export async function getUnresolvedThreads(deps: {
  prisma: PrismaService;
  gitlabService: GitlabService;
  issueId: string;
  mrIid: number;
  gitlabProjectId: number;
  agentRole: AgentRole;
}): Promise<FindingThread[]> {
  const { prisma, issueId, mrIid, agentRole } = deps;

  return prisma.findingThread.findMany({
    where: {
      issueId,
      mrIid,
      agentRole,
      resolved: false,
    },
    orderBy: { createdAt: 'asc' },
  });
}

// ─── resolveThreads ──────────────────────────────────────────

/**
 * Resolve FindingThreads both in GitLab (MR discussion) and locally (DB).
 * Each resolution is wrapped in try/catch so one failure doesn't block the rest.
 */
export async function resolveThreads(deps: {
  prisma: PrismaService;
  gitlabService: GitlabService;
  gitlabProjectId: number;
  mrIid: number;
  threadIds: string[];
}): Promise<void> {
  const { prisma, gitlabService, gitlabProjectId, mrIid, threadIds } = deps;

  for (const threadId of threadIds) {
    try {
      const thread = await prisma.findingThread.findUnique({
        where: { id: threadId },
      });

      if (!thread) {
        logger.warn(`FindingThread ${threadId} not found, skipping resolve`);
        continue;
      }

      if (thread.resolved) continue;

      // Resolve in GitLab first — only mark locally if GitLab succeeds
      try {
        await gitlabService.resolveMrDiscussion(
          gitlabProjectId,
          mrIid,
          thread.discussionId,
          true,
        );

        // Mark resolved locally only after GitLab confirms
        await prisma.findingThread.update({
          where: { id: threadId },
          data: { resolved: true },
        });
      } catch (err) {
        logger.warn(
          `GitLab resolve failed for discussion ${thread.discussionId} on MR !${mrIid}: ${err.message} — keeping local state unresolved`,
        );
      }
    } catch (err) {
      logger.error(
        `Failed to resolve FindingThread ${threadId}: ${err.message}`,
      );
    }
  }
}

// ─── syncFindingThreads (DRY — replaces duplicated logic in all agents) ──

export interface SyncFindingThreadsResult {
  /** All currently active (unresolved) threads */
  activeThreads: FindingThread[];
  /** Threads that were resolved in this sync */
  resolvedThreads: FindingThread[];
  /** Newly created threads */
  newThreads: FindingThread[];
}

/**
 * One-call function that handles the full thread lifecycle:
 * 1. Load previous unresolved threads for this agent/issue/MR
 * 2. Compare with current findings by fingerprint
 * 3. Resolve threads for findings that disappeared
 * 4. Post new threads for findings not already tracked
 * 5. Return active + resolved + new for summary building
 *
 * Replaces the duplicated resolve/dedup/post logic in all 4 agents.
 */
export async function syncFindingThreads(deps: {
  prisma: PrismaService;
  gitlabService: GitlabService;
  issueId: string;
  mrIid: number;
  gitlabProjectId: number;
  agentRole: AgentRole;
  roundNumber: number;
  findings: FindingForThread[];
}): Promise<SyncFindingThreadsResult> {
  const {
    prisma,
    gitlabService,
    issueId,
    mrIid,
    gitlabProjectId,
    agentRole,
    roundNumber,
    findings,
  } = deps;

  // 1. Load previous unresolved threads
  const previousThreads = await getUnresolvedThreads({
    prisma,
    gitlabService,
    issueId,
    mrIid,
    gitlabProjectId,
    agentRole,
  });

  // 2. Compute fingerprints for current findings
  const currentFingerprints = new Set(
    findings.map((f) =>
      generateFingerprint(f.severity, f.file, f.message, f.line),
    ),
  );

  // 3. Resolve threads whose findings are no longer present
  const resolvedRecords = previousThreads.filter(
    (t) => !currentFingerprints.has(t.fingerprint),
  );
  if (resolvedRecords.length > 0) {
    await resolveThreads({
      prisma,
      gitlabService,
      gitlabProjectId,
      mrIid,
      threadIds: resolvedRecords.map((t) => t.id),
    });
  }

  // 4. Post only NEW findings (not already tracked by fingerprint)
  const existingFingerprints = new Set(
    previousThreads.map((t) => t.fingerprint),
  );
  const newFindings = findings.filter(
    (f) =>
      !existingFingerprints.has(
        generateFingerprint(f.severity, f.file, f.message, f.line),
      ),
  );

  const newThreads = await postFindingsAsThreads({
    prisma,
    gitlabService,
    issueId,
    mrIid,
    gitlabProjectId,
    agentRole,
    roundNumber,
    findings: newFindings,
  });

  // 5. Combine still-unresolved previous + newly created
  const stillUnresolved = previousThreads.filter((t) =>
    currentFingerprints.has(t.fingerprint),
  );
  const activeThreads = [...stillUnresolved, ...newThreads];

  return { activeThreads, resolvedThreads: resolvedRecords, newThreads };
}

// ─── buildIssueSummaryWithThreadLinks ─────────────────────────

/**
 * Build a markdown summary that includes linked finding threads.
 * Used by agents to post structured issue comments with clickable
 * links to the corresponding MR discussion threads.
 */
export function buildIssueSummaryWithThreadLinks(opts: {
  agentName: string;
  approved: boolean;
  summary: string;
  threads: FindingThread[];
  resolvedThreads?: FindingThread[];
}): string {
  const { agentName, approved, summary, threads, resolvedThreads } = opts;

  const statusEmoji = approved ? '\u2705' : '\u26A0\uFE0F';
  const statusText = approved ? 'APPROVED' : 'CHANGES REQUESTED';

  const lines: string[] = [
    `## ${statusEmoji} ${agentName}: ${statusText}`,
    '',
    summary,
  ];

  // Active (unresolved) findings with thread links
  if (threads.length > 0) {
    lines.push('', '### Findings (posted as MR discussion threads):');
    for (const t of threads) {
      const icon = severityIcon(t.severity);
      lines.push(`- ${icon} [${t.message}](${t.threadUrl})`);
    }
  }

  // Previously resolved findings
  if (resolvedThreads && resolvedThreads.length > 0) {
    lines.push('', '### Resolved from previous round:');
    for (const t of resolvedThreads) {
      lines.push(`- \u2705 ~~${t.message}~~ \u2192 fixed`);
    }
  }

  return lines.join('\n');
}
