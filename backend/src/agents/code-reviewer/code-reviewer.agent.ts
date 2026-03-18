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
import { MonitorGateway } from '../../monitor/monitor.gateway';
import { DualTestService } from '../dual-test.service';
import {
  postAgentComment,
  getAgentCommentHistory,
  extractLastAgentFindings,
} from '../agent-comment.utils';
import {
  buildArchitectScopeGuardSection,
  extractArchitectOutOfScopeItems,
  filterOutOfScopeFindings,
} from '../agent-scope.utils';
import {
  syncFindingThreads,
  buildIssueSummaryWithThreadLinks,
  FindingForThread,
} from '../finding-thread.utils';
import { ReviewResult, ReviewFinding } from './review-result.interface';
import {
  AgentRole,
  AgentStatus,
  AgentTaskStatus,
  IssueStatus,
} from '@prisma/client';

/** Marker the LLM emits when review is done */
const COMPLETION_MARKER = ':::REVIEW_COMPLETE:::';

const DEFAULT_SYSTEM_PROMPT = `You are the Code Reviewer Agent for VibCode Hub — an AI development team platform.

## Your Role
You review merge request diffs for code quality, security, correctness, and best practices.

## Review Guidelines
- Check for bugs, logic errors, and edge cases
- Verify error handling is adequate
- Look for security issues (injection, XSS, auth bypass, etc.)
- Check code style and readability
- Verify the code actually implements what the issue describes

## Code Structure Quality (check these!)
- **File size**: Flag files exceeding ~300 lines — they should be split into smaller, focused modules
- **Single responsibility**: Each file/class/function should do ONE thing. Functions over ~50 lines are too long.
- **No spaghetti**: Deep nesting (>3 levels of if/for/try) is a warning. Suggest extracting helper methods.
- **No copy-paste**: Duplicated logic across files is a warning. Suggest extracting shared utils.
- **Logical structure**: Files should be grouped by feature/domain, not dumped in a flat folder.
- **Naming**: File names should clearly reflect their content (e.g., keycloak.service.ts, not utils2.ts)
- Be constructive — suggest fixes, not just point out problems
- For EACH finding, include an \`expectedFix\` field showing the CONCRETE code change or pattern you want to see

## Expectation Pattern (Anti-Loop Protocol)
You are part of an iterative review pipeline. To prevent infinite fix loops:
1. **Review Previous Round:** If "Previous Agent Comments" exist, find YOUR OWN previous findings first. For each one, check whether the Coder addressed it in the current diff.
2. **Classify Each Previous Finding:**
   - \`resolved\`: Fixed correctly. Report in \`resolvedFromPrevious\`. Do NOT re-report as new finding.
   - \`unresolved\`: Not addressed at all. Carry forward with SAME wording — do NOT rephrase.
   - \`blocked\`: Cannot verify (e.g., needs runtime). NOT a rejection reason on its own.
3. **Mandatory Expectations:** For every REJECT finding, the \`expectedFix\` field MUST contain CONCRETE code or pseudocode — not "add validation" but the actual code snippet. This is a contract: if the Coder implements this exactly, you SHOULD approve next round.
4. **No Goalpost Shifting:** Do NOT add new requirements to an existing finding across rounds. New discoveries are NEW findings.
5. **No Rephrasing:** If you reported "Missing aud validation" in round 1, do NOT report "JWT audience not checked" in round 2. Use the SAME message text. Rephrasing wastes fix cycles.
6. **Persistence Escalation:** Carry \`firstReportedRound\` forward. After 3+ rounds, make your \`expectedFix\` even MORE specific (include exact file, line, and code).

## Severity Levels
- **critical**: Security vulnerabilities, data loss risks, crashes, broken functionality
- **warning**: Bug risks, poor patterns, missing validation, performance issues
- **info**: Style suggestions, minor improvements, documentation gaps

## Decision Rules
- **APPROVE** if: No critical findings AND ≤2 warnings
- **REQUEST CHANGES** if: Any critical findings OR >2 warnings

## Completion Format
End your review with EXACTLY this format:

${COMPLETION_MARKER}
\`\`\`json
{
  "approved": true,
  "summary": "Brief 1-2 sentence summary",
  "roundNumber": 1,
  "resolvedFromPrevious": [
    {
      "message": "Previous finding that was fixed",
      "resolvedBy": "How the Coder fixed it"
    }
  ],
  "findings": [
    {
      "severity": "warning",
      "file": "src/example.ts",
      "line": 42,
      "message": "Missing null check",
      "suggestion": "Add a null check before accessing the property",
      "expectedFix": "Add \`if (!user) throw new UnauthorizedException();\` before line 42",
      "firstReportedRound": 1,
      "status": "new"
    }
  ]
}
\`\`\`

CRITICAL: The JSON must be valid. "approved" must be boolean. "severity" must be "info", "warning", or "critical". "status" must be "new", "resolved", "unresolved", or "blocked".`;

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
      const MAX_DIFF_CHARS = 20000;
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

      const userPrompt = `Review the following merge request${previousFindings.length > 0 ? ' (Re-review after fix attempt)' : ''}:

**Issue:** ${issue.title}
**Description:** ${issue.description || 'N/A'}
${previousFindingsSection}${historySection}${knowledgeSection}
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
      let reviewResult = this.parseReviewResult(
        dualResult.primary.content,
        issueId,
        mrIid,
      );

      // If parsing returned 0 findings but the response was substantial, retry JSON extraction
      if (
        reviewResult &&
        reviewResult.findings.length === 0 &&
        dualResult.primary.content.length > 500
      ) {
        const retryJson = await this.dualTestService.retryJsonExtraction(
          config,
          dualResult.primary.content,
          '{"approved": true/false, "summary": "1-2 sentences", "findings": [{"severity": "critical|warning|info", "file": "path", "line": 0, "message": "description", "suggestion": "fix"}]}',
        );
        if (retryJson) {
          const retried = this.parseReviewResult(retryJson, issueId, mrIid);
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
        const secondaryReview = this.parseReviewResult(
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

          // Code reviews tolerate more warnings than tests — approve with up to 5 non-critical warnings
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

      // Enforce Architect out-of-scope constraints server-side to prevent false review loops.
      reviewResult = this.applyArchitectScopeFilter(
        reviewResult,
        outOfScopeItems,
      );

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

      // Post issue summary with thread links (backward-compatible)
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
      this.logger.error(`Review failed: ${err.message}`, err.stack);
      await this.sendAgentMessage(
        ctx,
        `❌ **Code Reviewer** error: ${err.message}`,
      );
      await this.markFailed(ctx, err.message);
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

    // Update issue → TESTING
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
      // Log the EXACT data that failed to save for debugging
      this.logger.error(`JSONB save failed in handleApproved: ${saveErr.message}`);
      this.logger.error(`Sanitized output type: ${typeof sanitizedOutput}, JSON.stringify length: ${JSON.stringify(sanitizedOutput ?? null).length}`);
      this.logger.error(`Sanitized output sample: ${JSON.stringify(sanitizedOutput ?? null).substring(0, 500)}`);
      // Retry with a minimal safe output
      await this.prisma.agentTask.update({
        where: { id: ctx.agentTaskId },
        data: {
          status: AgentTaskStatus.COMPLETED,
          output: { summary: reviewResult.summary?.substring(0, 200) ?? 'Save failed', approved: reviewResult.approved, findings: [] } as any,
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

    // Update issue → IN_PROGRESS
    const changedIssue = await this.prisma.issue.update({
      where: { id: issueId },
      data: { status: IssueStatus.IN_PROGRESS },
    });

    // Sync status label to GitLab
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
      this.logger.error(`JSONB save failed in handleChangesRequested: ${saveErr.message}`);
      this.logger.error(`Output sample: ${JSON.stringify(sanitizedChangesOutput ?? null).substring(0, 500)}`);
      // Retry with minimal safe output — preserve findings count + summary for pipeline logic
      await this.prisma.agentTask.update({
        where: { id: ctx.agentTaskId },
        data: {
          status: AgentTaskStatus.COMPLETED,
          output: {
            summary: reviewResult.summary?.substring(0, 200) ?? 'Save failed',
            approved: reviewResult.approved,
            findings: reviewResult.findings.map(f => ({ severity: f.severity, file: f.file, message: (f.message ?? '').substring(0, 200) })),
          } as any,
          completedAt: new Date(),
        },
      });
    }

    await this.updateStatus(ctx, AgentStatus.IDLE);

    // Build feedback for Coder — include expectedFix and persistence info
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

  // ─── Parsing ──────────────────────────────────────────────

  private parseReviewResult(
    content: string,
    issueId: string,
    mrIid: number,
  ): ReviewResult | null {
    this.logger.debug(`Parsing review result (${content.length} chars)`);

    if (!content.trim()) {
      this.logger.error('Review content is empty — LLM returned nothing');
      return null;
    }

    // Step 1: Strip <think> tags (deepseek-r1 may include them even with think:false)
    const cleaned = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

    if (cleaned.length !== content.length) {
      this.logger.debug(
        `Stripped <think> tags: ${content.length} → ${cleaned.length} chars`,
      );
    }

    // Step 2: Try to extract JSON after the completion marker
    let jsonStr = this.extractJsonFromReview(cleaned);

    if (!jsonStr) {
      this.logger.warn(
        'Could not extract JSON from review — attempting text-based analysis',
      );
      return this.buildResultFromText(cleaned, issueId, mrIid);
    }

    try {
      // Fix common JSON issues
      jsonStr = jsonStr.replace(/,\s*([}\]])/g, '$1'); // trailing commas
      jsonStr = jsonStr.replace(/[\x00-\x1F\x7F]/g, ' '); // control chars

      const parsed = JSON.parse(jsonStr);

      // Normalize different JSON formats:
      // Format A (expected): { approved: bool, summary: str, findings: [...] }
      // Format B (deepseek-r1): { status: "APPROVED"|"CHANGES_REQUIRED", issues: [...], summary?: str }
      // Format C: { decision: "approve"|"reject", comments: [...] }
      const approved = this.normalizeApproval(parsed);
      const findings = this.parseFindings(
        parsed.findings ||
          parsed.issues ||
          parsed.comments ||
          parsed.problems ||
          [],
      );
      // Build summary — avoid using status/decision strings as summary
      let summary = parsed.summary || this.extractSummaryFromText(cleaned);
      // Clean up common prefixes from extracted summaries
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

      // Repair "No details" findings by extracting info from the summary or raw text
      // Some LLMs (gpt-5.3-codex) put finding details in summary instead of finding objects
      const noDetailFindings = findings.filter(f => f.message === 'No details');
      if (noDetailFindings.length > 0) {
        // Strategy 1: Parse numbered items from summary: "1. 🔴 Description (file:line)"
        if (summary && summary.length > 20) {
          const summaryItems = summary.match(/\d+\.\s*[🔴🟡🔵⚠️]?\s*\*?\*?(?:critical|warning|info)?:?\*?\*?\s*(.+?)(?=\d+\.\s*[🔴🟡🔵⚠️]|$)/gi) || [];
          for (let i = 0; i < noDetailFindings.length && i < summaryItems.length; i++) {
            const item = summaryItems[i].replace(/^\d+\.\s*[🔴🟡🔵⚠️]?\s*\*?\*?(?:critical|warning|info)?:?\*?\*?\s*/i, '').trim();
            if (item.length > 5) {
              noDetailFindings[i].message = item.substring(0, 300);
              this.logger.debug(`Repaired "No details" finding ${i + 1} from summary: ${item.substring(0, 80)}`);
            }
          }
        }

        // Strategy 2: Try extracting from the raw text before the JSON
        // Look for bullet points, numbered lists, or severity markers in the pre-JSON text
        const stillEmpty = findings.filter(f => f.message === 'No details');
        if (stillEmpty.length > 0) {
          const markerPos = cleaned.indexOf(COMPLETION_MARKER);
          const beforeJson = markerPos > 0 ? cleaned.substring(0, markerPos) : cleaned.substring(0, cleaned.lastIndexOf('{'));
          if (beforeJson.length > 50) {
            // Find severity-tagged lines: **critical**, **warning**, 🔴, etc.
            const detailLines = beforeJson.match(/(?:^|\n)\s*(?:\d+\.\s*)?(?:[🔴🟡🔵]\s*)?(?:\*\*(?:critical|warning|info)\*\*[:\s—–-]*)?(.{10,200}?)(?=\n\s*(?:\d+\.|\*\*|[🔴🟡🔵]|$))/gim) || [];
            const cleanLines = detailLines
              .map(l => l.replace(/^\s*\d+\.\s*/, '').replace(/[🔴🟡🔵]\s*/, '').replace(/\*\*/g, '').trim())
              .filter(l => l.length > 10 && !l.startsWith('```') && !l.startsWith('##'));
            for (let i = 0; i < stillEmpty.length && i < cleanLines.length; i++) {
              stillEmpty[i].message = cleanLines[i].substring(0, 300);
              this.logger.debug(`Repaired "No details" finding ${i + 1} from raw text: ${cleanLines[i].substring(0, 80)}`);
            }
          }
        }

        // Strategy 3: If ALL findings are STILL "No details" after repair,
        // this review is useless — don't send empty findings to the Coder
        const finallyEmpty = findings.filter(f => f.message === 'No details');
        if (finallyEmpty.length === findings.length && findings.length > 0) {
          this.logger.warn(
            `All ${findings.length} findings have "No details" after repair attempts — treating as parse failure`,
          );
          // Remove the empty findings so rule-based approval kicks in (0 findings = approve)
          // This prevents the Coder from getting useless "No details" feedback
          findings.length = 0;
        }
      }

      // Apply decision rules ourselves — don't blindly trust LLM's "approved" field
      // APPROVE if: no critical findings AND ≤2 warnings (matches system prompt)
      const criticalFindings = findings.filter(
        (f) => f.severity === 'critical',
      );
      const warningFindings = findings.filter((f) => f.severity === 'warning');
      const ruleBasedApproval =
        criticalFindings.length === 0 && warningFindings.length <= 2;

      if (ruleBasedApproval !== approved) {
        this.logger.warn(
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

      this.logger.log(
        `Parsed review: approved=${result.approved}, findings=${result.findings.length} (${criticalFindings.length}C/${warningFindings.length}W), summary="${result.summary.substring(0, 80)}"`,
      );
      return result;
    } catch (err) {
      this.logger.error(
        `JSON parse failed: ${err.message} — raw JSON: ${jsonStr.substring(0, 200)}`,
      );
      // Fall back to text analysis
      return this.buildResultFromText(cleaned, issueId, mrIid);
    }
  }

  /**
   * Extract JSON from the review content using multiple strategies.
   */
  private extractJsonFromReview(content: string): string | null {
    // Strategy 1: After :::REVIEW_COMPLETE::: marker
    if (content.includes(COMPLETION_MARKER)) {
      const afterMarker = content
        .substring(
          content.indexOf(COMPLETION_MARKER) + COMPLETION_MARKER.length,
        )
        .trim();
      const json = this.findJsonObject(afterMarker);
      if (json) return json;
    }

    // Strategy 2: JSON in code fences (```json ... ```)
    const fenceMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (fenceMatch) {
      const json = this.findJsonObject(fenceMatch[1]);
      if (json) return json;
    }

    // Strategy 3: Last JSON object in the content (review JSON is usually at the end)
    // Validate each candidate actually parses as JSON to avoid matching code blocks
    const allJsonMatches = [
      ...content.matchAll(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g),
    ];
    if (allJsonMatches.length > 0) {
      for (let i = allJsonMatches.length - 1; i >= 0; i--) {
        const candidate = allJsonMatches[i][0];
        if (
          candidate.includes('"approved"') ||
          candidate.includes('"findings"') ||
          candidate.includes('"status"') ||
          candidate.includes('"issues"')
        ) {
          try {
            JSON.parse(candidate);
            return candidate;
          } catch {
            continue;
          }
        }
      }
    }

    // Strategy 4: Greedy match — must also validate as parseable JSON
    const greedyMatch = content.match(
      /\{[\s\S]*(?:"approved"|"status")[\s\S]*\}/,
    );
    if (greedyMatch) {
      try {
        JSON.parse(greedyMatch[0]);
        return greedyMatch[0];
      } catch {
        /* skip */
      }
    }

    return null;
  }

  /**
   * Find a valid JSON object in a string.
   */
  private findJsonObject(str: string): string | null {
    // Strip markdown code fences if present
    const stripped = str
      .replace(/^```(?:json)?\s*\n?/, '')
      .replace(/\n?```\s*$/, '')
      .trim();
    const match = stripped.match(/\{[\s\S]*\}/);
    return match ? match[0] : null;
  }

  /**
   * Normalize the approval field from various JSON formats.
   */
  private normalizeApproval(parsed: any): boolean {
    // Direct boolean
    if (typeof parsed.approved === 'boolean') return parsed.approved;
    // String "true"/"false"
    if (typeof parsed.approved === 'string')
      return parsed.approved.toLowerCase() === 'true';
    // Status string (deepseek-r1 format)
    if (parsed.status) {
      const status = String(parsed.status).toLowerCase();
      return status === 'approved' || status === 'approve' || status === 'lgtm';
    }
    // Decision string
    if (parsed.decision) {
      const decision = String(parsed.decision).toLowerCase();
      return (
        decision === 'approve' || decision === 'approved' || decision === 'lgtm'
      );
    }
    // Fallback: if there are critical findings, not approved
    return false;
  }

  /**
   * Parse findings array with validation.
   * Handles multiple formats: findings, issues, comments, problems.
   */
  private parseFindings(rawFindings: any): ReviewFinding[] {
    if (!Array.isArray(rawFindings)) return [];
    const result = rawFindings
      .filter((f: any) => f && typeof f === 'object')
      .map((f: any) => ({
        severity: this.normalizeSeverity(f.severity || f.type || f.level),
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
      if (finding.message && /^(Erwarteter Fix|Expected Fix|Fix:|Suggestion:|Empfehlung:)/i.test(finding.message)) {
        // Move the fix text to expectedFix if not already set
        if (!finding.expectedFix) {
          finding.expectedFix = finding.message;
        }
        // Try to use suggestion as the real message, or mark as needs-detail
        finding.message = finding.suggestion ?? `Finding in ${finding.file}${finding.line ? `:${finding.line}` : ''} (see expectedFix for details)`;
      }
    }

    return result;
  }

  private normalizeSeverity(raw: any): 'info' | 'warning' | 'critical' {
    if (!raw) return 'warning';
    const s = String(raw).toLowerCase();
    if (['critical', 'error', 'high', 'major', 'blocker'].includes(s))
      return 'critical';
    if (['warning', 'warn', 'medium', 'minor'].includes(s)) return 'warning';
    return 'info';
  }

  /**
   * Fallback: analyze the review text to determine approval/findings
   * when JSON parsing fails completely.
   */
  private buildResultFromText(
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
      this.extractSummaryFromText(text) ||
      'Review analysis completed (parsed from text)';

    // Build synthetic findings from text analysis
    const findings: ReviewFinding[] = [];
    const findingPattern =
      /(?:^|\n)\s*(?:\d+\.\s*)?(?:\*\*)?(?:(?:critical|warning|info)[:\s—-]+)(.*?)(?:\n|$)/gi;
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

    // Apply decision rules: no critical findings AND ≤2 warnings → approve
    // This prevents false rejections when the LLM doesn't output clear keywords
    const criticalFindings = findings.filter((f) => f.severity === 'critical');
    const warningFindings = findings.filter((f) => f.severity === 'warning');
    const ruleBasedApproval =
      criticalFindings.length === 0 && warningFindings.length <= 2;

    // Use rule-based approval but let explicit rejection override if findings back it up
    const approved = ruleBasedApproval || (hasApproved && !hasChangesRequested);

    this.logger.log(
      `Text-based review: approved=${approved} (rule=${ruleBasedApproval}, keywords: approve=${hasApproved}, reject=${hasChangesRequested}), criticals=${criticalCount}, warnings=${warningCount}, findings=${findings.length}`,
    );

    return { issueId, mrIid, approved, summary, findings };
  }

  /**
   * Extract a summary sentence from the review text.
   */
  private extractSummaryFromText(text: string): string | null {
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

  // ─── Diff Fetching ──────────────────────────────────────

  private applyArchitectScopeFilter(
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

    this.logger.log(
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

      // Emit failure event so orchestrator can pause the pipeline
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
