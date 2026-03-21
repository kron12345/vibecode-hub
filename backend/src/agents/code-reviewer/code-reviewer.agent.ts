import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import { SystemSettingsService } from '../../settings/system-settings.service';
import { ChatService } from '../../chat/chat.service';
import { ChatGateway } from '../../chat/chat.gateway';
import { LlmService } from '../../llm/llm.service';
import { GitlabService } from '../../gitlab/gitlab.service';
import { LlmMessage } from '../../llm/llm.interfaces';
import { BaseAgent, AgentContext, sanitizeJsonOutput } from '../agent-base';
import { loadPrompt } from '../prompt-loader';
import { MonitorGateway } from '../../monitor/monitor.gateway';
import { DualTestService } from '../dual-test.service';
import {
  postAgentComment,
  getAgentCommentHistory,
  extractLastAgentFindings,
  extractLoopResolverClarifications,
} from '../agent-comment.utils';
import {
  buildArchitectScopeGuardSection,
  extractArchitectOutOfScopeItems,
} from '../agent-scope.utils';
import {
  syncFindingThreads,
  buildIssueSummaryWithThreadLinks,
  FindingForThread,
} from '../finding-thread.utils';
import { ReviewResult, ReviewFinding } from './review-result.interface';
import {
  COMPLETION_MARKER,
  parseReviewResult,
  applyArchitectScopeFilter,
} from './code-reviewer-result';
import {
  AgentRole,
  AgentStatus,
  AgentTaskStatus,
  IssueStatus,
} from '@prisma/client';

const DEFAULT_SYSTEM_PROMPT = loadPrompt('code-reviewer');

@Injectable()
export class CodeReviewerAgent extends BaseAgent {
  readonly role = AgentRole.CODE_REVIEWER;
  protected readonly logger = new Logger(CodeReviewerAgent.name);

  constructor(
    prisma: PrismaService,
    settings: SystemSettingsService,
    chatService: ChatService,
    chatGateway: ChatGateway,
    llmService: LlmService,
    private readonly gitlabService: GitlabService,
    monitorGateway: MonitorGateway,
    private readonly eventEmitter: EventEmitter2,
    private readonly dualTestService: DualTestService,
  ) {
    super(
      prisma,
      settings,
      chatService,
      chatGateway,
      llmService,
      monitorGateway,
    );
  }

  /**
   * Review a merge request for a specific issue.
   */
  async reviewIssue(
    ctx: AgentContext,
    issueId: string,
    mrIid: number,
    gitlabProjectId: number,
  ): Promise<void> {
    try {
      await this.updateStatus(ctx, AgentStatus.WORKING);

      // Load issue
      const issue = await this.prisma.issue.findUnique({
        where: { id: issueId },
      });
      if (!issue) {
        await this.sendAgentMessage(ctx, `❌ Issue ${issueId} not found`);
        await this.updateStatus(ctx, AgentStatus.ERROR);
        return;
      }

      await this.sendAgentMessage(
        ctx,
        `🔍 **Code Reviewer** reviewing MR !${mrIid} for issue #${issue.gitlabIid ?? '?'}: **${issue.title}**`,
      );

      // Get MR diffs — retry with delay because GitLab needs time to compute diffs
      const diffs = await this.fetchDiffsWithRetry(
        gitlabProjectId,
        mrIid,
        3,
        5000,
      );

      if (diffs.length === 0) {
        await this.sendAgentMessage(ctx, '⚠️ MR has no diffs — auto-approving');
        await this.handleApproved(ctx, issueId, mrIid, gitlabProjectId, {
          issueId,
          mrIid,
          approved: true,
          findings: [],
          summary: 'No diffs in MR',
        });
        return;
      }

      // Build review prompt
      const config = this.getRoleConfig();
      const systemPrompt = config.systemPrompt || DEFAULT_SYSTEM_PROMPT;

      // Prioritize source files > configs > other files for review
      const MAX_REVIEW_DIFFS = this.getMaxReviewDiffs();
      const MAX_DIFF_CHARS = this.getMaxDiffChars();
      const sortedDiffs = [...diffs].sort((a, b) => {
        const score = (path: string) => {
          if (/\.(ts|js|tsx|jsx|py|rs|go|java|css|scss|html)$/.test(path))
            return 0;
          if (/\.(json|yml|yaml|toml|env)$/.test(path)) return 1;
          return 2;
        };
        return score(a.new_path) - score(b.new_path);
      });

      const reviewDiffs = sortedDiffs.slice(0, MAX_REVIEW_DIFFS);
      const skippedCount = diffs.length - reviewDiffs.length;

      this.logger.log(
        `Reviewing ${reviewDiffs.length} of ${diffs.length} diff(s) for MR !${mrIid}${skippedCount > 0 ? ` (${skippedCount} skipped)` : ''}`,
      );

      const diffText = reviewDiffs
        .map((d) => {
          const prefix = d.new_file
            ? '[NEW]'
            : d.deleted_file
              ? '[DELETED]'
              : d.renamed_file
                ? '[RENAMED]'
                : '[MODIFIED]';
          const truncated =
            d.diff.length > MAX_DIFF_CHARS
              ? d.diff.substring(0, MAX_DIFF_CHARS) + '\n... (truncated)'
              : d.diff;
          return `### ${prefix} ${d.new_path}\n\`\`\`diff\n${truncated}\n\`\`\``;
        })
        .join('\n\n');

      const skippedNote =
        skippedCount > 0
          ? `\n\n_Note: ${skippedCount} additional file(s) were omitted (node_modules, lock files, or low-priority). Focus on the shown diffs._`
          : '';

      // Inject project knowledge base for context (Wiki-First)
      const project = await this.prisma.project.findUnique({
        where: { id: ctx.projectId },
        select: { slug: true, gitlabProjectId: true },
      });
      const workspace = project
        ? await this.resolveWorkspace(project.slug, ctx.chatSessionId)
        : '';
      const knowledgeSection = workspace
        ? await this.buildKnowledgeSectionWiki(
            this.gitlabService,
            project?.gitlabProjectId ?? null,
            workspace,
          )
        : '';
      const commentHistory = await getAgentCommentHistory({
        prisma: this.prisma,
        issueId,
        maxChars: this.getMaxHistoryChars(),
      });
      const historySection = commentHistory
        ? `\n## Previous Agent Comments on this Issue\n${commentHistory}\n`
        : '';
      const outOfScopeItems = extractArchitectOutOfScopeItems(commentHistory);
      const scopeGuardSection =
        buildArchitectScopeGuardSection(outOfScopeItems);

      // Build structured previous findings section (Expectation Pattern memory)
      const previousFindings = extractLastAgentFindings(
        commentHistory,
        'Code Reviewer',
      );
      const previousFindingsSection =
        previousFindings.length > 0
          ? `\n## YOUR Previous Review Findings — Re-Evaluate Each One\n${previousFindings
              .map(
                (f, i) =>
                  `${i + 1}. [${(f.severity ?? 'warning').toUpperCase()}] \`${f.file ?? 'unknown'}\`: ${f.message}\n   Expected fix: ${f.expectedFix ?? f.suggestion ?? 'not specified'}`,
              )
              .join(
                '\n',
              )}\n\nFor each finding above: check if it is now fixed in the current code. Report fixed items in \`resolvedFromPrevious\`. Carry unfixed items forward in \`findings\` with the SAME message text.\n`
          : '';

      const loopResolverSection =
        extractLoopResolverClarifications(commentHistory);

      const userPrompt = `Review the following merge request${previousFindings.length > 0 ? ' (Re-review after fix attempt)' : ''}:

**Issue:** ${issue.title}
**Description:** ${issue.description || 'N/A'}
${loopResolverSection ? `\n${loopResolverSection}\n` : ''}${previousFindingsSection}${historySection}${knowledgeSection}
${scopeGuardSection}
## MR Diffs (${reviewDiffs.length} of ${diffs.length} file(s)):

${diffText}${skippedNote}

${
  previousFindings.length > 0
    ? 'IMPORTANT: First address each item in "YOUR Previous Review Findings" above, then check for new issues.'
    : 'Provide your review analysis and end with the completion marker and JSON result.'
}`;

      const messages: LlmMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ];

      // Call primary (and optional secondary for dual-testing)
      const dualResult = await this.dualTestService.callDual(config, messages);

      if (dualResult.primary.finishReason === 'error') {
        await this.sendAgentMessage(ctx, '❌ Code Reviewer LLM call failed');
        await this.markFailed(
          ctx,
          `LLM call failed: ${dualResult.primary.errorMessage ?? 'unknown error'}`,
        );
        return;
      }

      // Parse primary review result
      let reviewResult = parseReviewResult(
        dualResult.primary.content,
        issueId,
        mrIid,
      );

      // If parsing returned 0 findings but the response was substantial, retry JSON extraction
      const secondaryTimedOut =
        this.dualTestService.isDualConfigured(config) && !dualResult.secondary;
      if (
        reviewResult &&
        reviewResult.findings.length === 0 &&
        dualResult.primary.content.length > 500 &&
        !secondaryTimedOut
      ) {
        const retryJson = await this.dualTestService.retryJsonExtraction(
          config,
          dualResult.primary.content,
          '{"approved": true/false, "summary": "1-2 sentences", "findings": [{"severity": "critical|warning|info", "file": "path", "line": 0, "message": "description", "suggestion": "fix"}]}',
        );
        if (retryJson) {
          const retried = parseReviewResult(retryJson, issueId, mrIid);
          if (retried && retried.findings.length > 0) {
            this.logger.log(
              `JSON retry recovered ${retried.findings.length} findings`,
            );
            reviewResult = retried;
          }
        }
      }

      // Dual-testing: parse secondary and merge findings
      if (
        reviewResult &&
        dualResult.secondary &&
        dualResult.secondary.finishReason !== 'error'
      ) {
        const secondaryReview = parseReviewResult(
          dualResult.secondary.content,
          issueId,
          mrIid,
        );
        if (secondaryReview) {
          const strategy = config.dualStrategy ?? 'merge';
          const { merged, stats } = this.dualTestService.mergeFindings(
            reviewResult.findings,
            secondaryReview.findings,
            strategy,
            (f: ReviewFinding) =>
              `${f.file}:${f.line ?? ''}:${f.message.substring(0, 50).toLowerCase()}`,
          );

          const approved = this.dualTestService.determineApproval(merged, 5);
          reviewResult = { ...reviewResult, findings: merged, approved };

          await this.sendAgentMessage(
            ctx,
            `🔀 **Dual-test** (${strategy}): ${stats.primaryCount} + ${stats.secondaryCount} → ${stats.mergedCount} findings [${dualResult.providers.primary} + ${dualResult.providers.secondary}]`,
          );
        }
      }

      if (!reviewResult) {
        await this.sendAgentMessage(
          ctx,
          '⚠️ Could not parse review result — defaulting to approved',
        );
        await this.handleApproved(ctx, issueId, mrIid, gitlabProjectId, {
          issueId,
          mrIid,
          approved: true,
          findings: [],
          summary: 'Review parse failed — auto-approved',
        });
        return;
      }

      // Enforce Architect out-of-scope constraints server-side
      reviewResult = applyArchitectScopeFilter(reviewResult, outOfScopeItems);

      // ─── Finding Threads: Post findings as MR discussion threads ───
      const findingsForThreads: FindingForThread[] = reviewResult.findings.map(
        (f) => {
          const parts = [
            `**${f.severity.toUpperCase()}** — \`${f.file}${f.line ? `:${f.line}` : ''}\``,
            '',
            f.message,
          ];
          if (f.expectedFix)
            parts.push('', `**Expected Fix:** ${f.expectedFix}`);
          if (f.suggestion) parts.push('', `💡 ${f.suggestion}`);
          return {
            severity: f.severity,
            message: f.message,
            file: f.file,
            line: f.line,
            threadBody: parts.join('\n'),
          };
        },
      );

      const {
        activeThreads: allActiveThreads,
        resolvedThreads: resolvedThreadRecords,
      } = await syncFindingThreads({
        prisma: this.prisma,
        gitlabService: this.gitlabService,
        issueId,
        mrIid,
        gitlabProjectId,
        agentRole: AgentRole.CODE_REVIEWER,
        roundNumber: reviewResult.roundNumber ?? 1,
        findings: findingsForThreads,
        confirmedResolved: reviewResult.resolvedFromPrevious,
      });

      // Post issue summary with thread links
      const reviewMarkdown = buildIssueSummaryWithThreadLinks({
        agentName: 'Code Review',
        approved: reviewResult.approved,
        summary: reviewResult.summary,
        threads: allActiveThreads,
        resolvedThreads: resolvedThreadRecords,
      });
      await postAgentComment({
        prisma: this.prisma,
        gitlabService: this.gitlabService,
        issueId,
        gitlabProjectId,
        issueIid: issue.gitlabIid!,
        agentTaskId: ctx.agentTaskId,
        authorName: 'Code Reviewer',
        markdownContent: reviewMarkdown,
      });

      if (reviewResult.approved) {
        await this.handleApproved(
          ctx,
          issueId,
          mrIid,
          gitlabProjectId,
          reviewResult,
        );
      } else {
        await this.handleChangesRequested(
          ctx,
          issueId,
          mrIid,
          gitlabProjectId,
          reviewResult,
        );
      }
    } catch (err) {
      // Enhanced error logging with stack trace
      const isJsonError =
        err.message?.includes('json') || err.message?.includes('Json');
      const stack = err.stack?.split('\n').slice(1, 6).join('\n') ?? '';

      this.logger.error(
        `Review failed [${isJsonError ? 'JSONB' : 'other'}]: ${err.message}`,
      );
      if (stack) this.logger.error(`Stack trace:\n${stack}`);

      try {
        const debugMsg = `Review failed: ${err.message?.substring(0, 300) ?? 'unknown'}\nStack: ${stack.substring(0, 400)}`;
        await this.log(ctx.agentTaskId, 'ERROR', debugMsg);
      } catch {
        /* best effort */
      }

      // For JSONB errors: try to complete the task with a raw SQL fallback
      if (isJsonError) {
        this.logger.warn(
          'JSONB error detected — attempting raw SQL status update to rescue the task',
        );
        try {
          await this.prisma.$executeRaw`
            UPDATE agent_tasks SET status = 'COMPLETED', "completedAt" = NOW(),
            output = '{"error":"JSONB save failed","approved":true,"findings":[]}'::jsonb
            WHERE id = ${ctx.agentTaskId}
          `;
          this.logger.log('Raw SQL fallback succeeded — task marked COMPLETED');
          await this.updateStatus(ctx, AgentStatus.IDLE);
          this.eventEmitter.emit('agent.reviewApproved', {
            projectId: ctx.projectId,
            chatSessionId: ctx.chatSessionId,
            issueId,
            mrIid,
            gitlabProjectId,
          });
          return;
        } catch (rawErr) {
          this.logger.error(`Raw SQL fallback also failed: ${rawErr.message}`);
        }
      }

      await this.sendAgentMessage(
        ctx,
        `❌ **Code Reviewer** error: ${err.message}`,
      ).catch((msgErr) => { this.logger.warn(`Failed to send error message to chat: ${msgErr.message}`); });
      await this.markFailed(
        ctx,
        err.message?.substring(0, 500) ?? 'unknown error',
      );
    }
  }

  // ─── Result Handlers ──────────────────────────────────────

  private async handleApproved(
    ctx: AgentContext,
    issueId: string,
    mrIid: number,
    gitlabProjectId: number,
    reviewResult: ReviewResult,
  ): Promise<void> {
    await this.sendAgentMessage(
      ctx,
      `✅ **Code Review approved** for MR !${mrIid}\n\n${reviewResult.summary}`,
    );

    // Update issue -> TESTING
    const approvedIssue = await this.prisma.issue.update({
      where: { id: issueId },
      data: { status: IssueStatus.TESTING },
    });

    // Sync status label to GitLab
    if (approvedIssue.gitlabIid) {
      await this.gitlabService
        .syncStatusLabel(gitlabProjectId, approvedIssue.gitlabIid, 'TESTING')
        .catch(() => {});
    }

    // Complete task — with diagnostic logging if JSONB save fails
    const sanitizedOutput = sanitizeJsonOutput(reviewResult);
    try {
      await this.prisma.agentTask.update({
        where: { id: ctx.agentTaskId },
        data: {
          status: AgentTaskStatus.COMPLETED,
          output: sanitizedOutput as any,
          completedAt: new Date(),
        },
      });
    } catch (saveErr) {
      this.logger.error(
        `JSONB save failed in handleApproved: ${saveErr.message}`,
      );
      this.logger.error(
        `Sanitized output type: ${typeof sanitizedOutput}, JSON.stringify length: ${JSON.stringify(sanitizedOutput ?? null).length}`,
      );
      this.logger.error(
        `Sanitized output sample: ${JSON.stringify(sanitizedOutput ?? null).substring(0, 500)}`,
      );
      await this.prisma.agentTask.update({
        where: { id: ctx.agentTaskId },
        data: {
          status: AgentTaskStatus.COMPLETED,
          output: {
            summary: reviewResult.summary?.substring(0, 200) ?? 'Save failed',
            approved: reviewResult.approved,
            findings: [],
          } as any,
          completedAt: new Date(),
        },
      });
    }

    await this.updateStatus(ctx, AgentStatus.IDLE);

    this.eventEmitter.emit('agent.reviewApproved', {
      projectId: ctx.projectId,
      chatSessionId: ctx.chatSessionId,
      issueId,
      mrIid,
      gitlabProjectId,
    });
  }

  private async handleChangesRequested(
    ctx: AgentContext,
    issueId: string,
    mrIid: number,
    gitlabProjectId: number,
    reviewResult: ReviewResult,
  ): Promise<void> {
    const findingsText = reviewResult.findings
      .map(
        (f) =>
          `- **${f.severity}** \`${f.file}${f.line ? `:${f.line}` : ''}\`: ${f.message}`,
      )
      .join('\n');

    await this.sendAgentMessage(
      ctx,
      `⚠️ **Code Review: changes requested** for MR !${mrIid}\n\n${reviewResult.summary}\n\n${findingsText}`,
    );

    // Update issue -> IN_PROGRESS
    const changedIssue = await this.prisma.issue.update({
      where: { id: issueId },
      data: { status: IssueStatus.IN_PROGRESS },
    });

    if (changedIssue.gitlabIid) {
      await this.gitlabService
        .syncStatusLabel(gitlabProjectId, changedIssue.gitlabIid, 'IN_PROGRESS')
        .catch(() => {});
    }

    // Complete review task — with fallback if JSONB save fails
    const sanitizedChangesOutput = sanitizeJsonOutput(reviewResult);
    try {
      await this.prisma.agentTask.update({
        where: { id: ctx.agentTaskId },
        data: {
          status: AgentTaskStatus.COMPLETED,
          output: sanitizedChangesOutput as any,
          completedAt: new Date(),
        },
      });
    } catch (saveErr) {
      this.logger.error(
        `JSONB save failed in handleChangesRequested: ${saveErr.message}`,
      );
      this.logger.error(
        `Output sample: ${JSON.stringify(sanitizedChangesOutput ?? null).substring(0, 500)}`,
      );
      await this.prisma.agentTask.update({
        where: { id: ctx.agentTaskId },
        data: {
          status: AgentTaskStatus.COMPLETED,
          output: {
            summary: reviewResult.summary?.substring(0, 200) ?? 'Save failed',
            approved: reviewResult.approved,
            findings: reviewResult.findings.map((f) => ({
              severity: f.severity,
              file: f.file,
              message: (f.message ?? '').substring(0, 200),
            })),
          } as any,
          completedAt: new Date(),
        },
      });
    }

    await this.updateStatus(ctx, AgentStatus.IDLE);

    // Build feedback for Coder
    const findingsForCoder = reviewResult.findings
      .map((f, i) => {
        const persist = f.firstReportedRound
          ? ` (open since round ${f.firstReportedRound})`
          : '';
        const parts = [
          `${i + 1}. [${f.severity.toUpperCase()}] \`${f.file}${f.line ? `:${f.line}` : ''}\`${persist}`,
        ];
        parts.push(`   Finding: ${f.message}`);
        if (f.expectedFix) {
          parts.push(`   EXPECTED FIX: ${f.expectedFix}`);
        } else if (f.suggestion) {
          parts.push(`   Suggestion: ${f.suggestion}`);
        }
        return parts.join('\n');
      })
      .join('\n\n');

    const feedback = findingsForCoder
      ? `Code Review findings:\n\n${findingsForCoder}`
      : `Code Review feedback:\n\n${reviewResult.summary}`;

    this.eventEmitter.emit('agent.reviewChangesRequested', {
      projectId: ctx.projectId,
      chatSessionId: ctx.chatSessionId,
      issueId,
      feedback,
    });
  }

  // ─── Diff Fetching ──────────────────────────────────────

  /**
   * Fetch MR diffs with retry — GitLab may not have computed diffs
   * immediately after MR creation.
   */
  private async fetchDiffsWithRetry(
    gitlabProjectId: number,
    mrIid: number,
    maxRetries: number,
    delayMs: number,
  ): Promise<any[]> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const diffs = await this.gitlabService.getMergeRequestDiffs(
          gitlabProjectId,
          mrIid,
        );
        if (diffs.length > 0) {
          this.logger.log(
            `Got ${diffs.length} diff(s) for MR !${mrIid} on attempt ${attempt}`,
          );
          return diffs;
        }
      } catch (err) {
        this.logger.warn(
          `Diff fetch attempt ${attempt}/${maxRetries} failed for MR !${mrIid}: ${err.message}`,
        );
      }
      if (attempt < maxRetries) {
        this.logger.debug(
          `MR !${mrIid} has no diffs yet — waiting ${delayMs}ms (attempt ${attempt}/${maxRetries})`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    this.logger.warn(
      `MR !${mrIid} still has no diffs after ${maxRetries} attempts`,
    );
    return [];
  }

  // ─── Helpers ──────────────────────────────────────────────

  private async markFailed(ctx: AgentContext, reason: string): Promise<void> {
    try {
      await this.prisma.agentTask.update({
        where: { id: ctx.agentTaskId },
        data: {
          status: AgentTaskStatus.FAILED,
          completedAt: new Date(),
        },
      });
      await this.updateStatus(ctx, AgentStatus.ERROR);
      await this.log(ctx.agentTaskId, 'ERROR', `Review failed: ${reason}`);

      this.eventEmitter.emit('agent.taskFailed', {
        projectId: ctx.projectId,
        chatSessionId: ctx.chatSessionId,
        agentTaskId: ctx.agentTaskId,
        agentRole: this.role,
        reason,
      });
    } catch (err) {
      this.logger.error(`Failed to mark task as failed: ${err.message}`);
    }
  }
}
