import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import { SystemSettingsService } from '../../settings/system-settings.service';
import { ChatService } from '../../chat/chat.service';
import { ChatGateway } from '../../chat/chat.gateway';
import { LlmService } from '../../llm/llm.service';
import { GitlabService } from '../../gitlab/gitlab.service';
import { LlmMessage } from '../../llm/llm.interfaces';
import { BaseAgent, AgentContext } from '../agent-base';
import { postAgentComment } from '../agent-comment.utils';
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
- Be constructive — suggest fixes, not just point out problems

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
  "findings": [
    {
      "severity": "warning",
      "file": "src/example.ts",
      "line": 42,
      "message": "Missing null check",
      "suggestion": "Add a null check before accessing the property"
    }
  ]
}
\`\`\`

CRITICAL: The JSON must be valid. "approved" must be boolean. "severity" must be "info", "warning", or "critical".`;

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
    private readonly eventEmitter: EventEmitter2,
  ) {
    super(prisma, settings, chatService, chatGateway, llmService);
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
      let diffs = await this.fetchDiffsWithRetry(gitlabProjectId, mrIid, 3, 5000);

      if (diffs.length === 0) {
        await this.sendAgentMessage(ctx, '⚠️ MR has no diffs — auto-approving');
        await this.handleApproved(ctx, issueId, mrIid, gitlabProjectId, {
          issueId, mrIid, approved: true, findings: [], summary: 'No diffs in MR',
        });
        return;
      }

      // Build review prompt
      const config = this.getRoleConfig();
      const systemPrompt = config.systemPrompt || DEFAULT_SYSTEM_PROMPT;

      // Prioritize source files > configs > other files for review
      const MAX_REVIEW_DIFFS = 25;
      const MAX_DIFF_CHARS = 2000;
      const sortedDiffs = [...diffs].sort((a, b) => {
        const score = (path: string) => {
          if (/\.(ts|js|tsx|jsx|py|rs|go|java|css|scss|html)$/.test(path)) return 0;
          if (/\.(json|yml|yaml|toml|env)$/.test(path)) return 1;
          return 2;
        };
        return score(a.new_path) - score(b.new_path);
      });

      const reviewDiffs = sortedDiffs.slice(0, MAX_REVIEW_DIFFS);
      const skippedCount = diffs.length - reviewDiffs.length;

      this.logger.log(`Reviewing ${reviewDiffs.length} of ${diffs.length} diff(s) for MR !${mrIid}${skippedCount > 0 ? ` (${skippedCount} skipped)` : ''}`);

      const diffText = reviewDiffs.map(d => {
        const prefix = d.new_file ? '[NEW]' : d.deleted_file ? '[DELETED]' : d.renamed_file ? '[RENAMED]' : '[MODIFIED]';
        const truncated = d.diff.length > MAX_DIFF_CHARS ? d.diff.substring(0, MAX_DIFF_CHARS) + '\n... (truncated)' : d.diff;
        return `### ${prefix} ${d.new_path}\n\`\`\`diff\n${truncated}\n\`\`\``;
      }).join('\n\n');

      const skippedNote = skippedCount > 0
        ? `\n\n_Note: ${skippedCount} additional file(s) were omitted (node_modules, lock files, or low-priority). Focus on the shown diffs._`
        : '';

      const userPrompt = `Review the following merge request:

**Issue:** ${issue.title}
**Description:** ${issue.description || 'N/A'}

## MR Diffs (${reviewDiffs.length} of ${diffs.length} file(s)):

${diffText}${skippedNote}

Provide your review analysis and end with the completion marker and JSON result.`;

      const messages: LlmMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ];

      // deepseek-r1 needs extra time for large diffs
      const result = await this.callLlm(messages, { timeoutMs: 900_000 });

      if (result.finishReason === 'error') {
        await this.sendAgentMessage(ctx, '❌ Code Reviewer LLM call failed');
        await this.markFailed(ctx, 'LLM call failed');
        return;
      }

      // Parse review result
      const reviewResult = this.parseReviewResult(result.content, issueId, mrIid);

      if (!reviewResult) {
        await this.sendAgentMessage(ctx, '⚠️ Could not parse review result — defaulting to approved');
        await this.handleApproved(ctx, issueId, mrIid, gitlabProjectId, {
          issueId, mrIid, approved: true, findings: [], summary: 'Review parse failed — auto-approved',
        });
        return;
      }

      // Post unified review comment (same rich markdown for local + GitLab)
      const reviewMarkdown = this.buildReviewMarkdown(reviewResult);
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
        await this.handleApproved(ctx, issueId, mrIid, gitlabProjectId, reviewResult);
      } else {
        await this.handleChangesRequested(ctx, issueId, mrIid, gitlabProjectId, reviewResult);
      }

    } catch (err) {
      this.logger.error(`Review failed: ${err.message}`, err.stack);
      await this.sendAgentMessage(ctx, `❌ **Code Reviewer** error: ${err.message}`);
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
      await this.gitlabService.syncStatusLabel(gitlabProjectId, approvedIssue.gitlabIid, 'TESTING').catch(() => {});
    }

    // Complete task
    await this.prisma.agentTask.update({
      where: { id: ctx.agentTaskId },
      data: {
        status: AgentTaskStatus.COMPLETED,
        output: reviewResult as any,
        completedAt: new Date(),
      },
    });

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
      .map(f => `- **${f.severity}** \`${f.file}${f.line ? `:${f.line}` : ''}\`: ${f.message}`)
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
      await this.gitlabService.syncStatusLabel(gitlabProjectId, changedIssue.gitlabIid, 'IN_PROGRESS').catch(() => {});
    }

    // Complete review task
    await this.prisma.agentTask.update({
      where: { id: ctx.agentTaskId },
      data: {
        status: AgentTaskStatus.COMPLETED,
        output: reviewResult as any,
        completedAt: new Date(),
      },
    });

    await this.updateStatus(ctx, AgentStatus.IDLE);

    // Build feedback for Coder — include summary if no findings
    const findingsForCoder = reviewResult.findings
      .map(f => `[${f.severity.toUpperCase()}] ${f.file}${f.line ? `:${f.line}` : ''}: ${f.message}${f.suggestion ? ` → ${f.suggestion}` : ''}`)
      .join('\n');

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

  private parseReviewResult(content: string, issueId: string, mrIid: number): ReviewResult | null {
    this.logger.debug(`Parsing review result (${content.length} chars)`);

    if (!content.trim()) {
      this.logger.error('Review content is empty — LLM returned nothing');
      return null;
    }

    // Step 1: Strip <think> tags (deepseek-r1 may include them even with think:false)
    let cleaned = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

    if (cleaned.length !== content.length) {
      this.logger.debug(`Stripped <think> tags: ${content.length} → ${cleaned.length} chars`);
    }

    // Step 2: Try to extract JSON after the completion marker
    let jsonStr = this.extractJsonFromReview(cleaned);

    if (!jsonStr) {
      this.logger.warn('Could not extract JSON from review — attempting text-based analysis');
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
      const findings = this.parseFindings(parsed.findings || parsed.issues || parsed.comments || parsed.problems || []);
      // Build summary — avoid using status/decision strings as summary
      let summary = parsed.summary || this.extractSummaryFromText(cleaned);
      // Clean up common prefixes from extracted summaries
      if (summary) {
        summary = summary.replace(/^[:\s]*(?:CHANGES_REQUIRED|APPROVED|CHANGES REQUESTED)[:\s]*/i, '').trim();
      }
      if (!summary || summary.length < 5) {
        summary = approved ? 'Code review passed' : `Changes requested (${findings.length} finding(s))`;
      }

      const result: ReviewResult = {
        issueId,
        mrIid,
        approved,
        summary,
        findings,
      };

      this.logger.log(`Parsed review: approved=${result.approved}, findings=${result.findings.length}, summary="${result.summary.substring(0, 80)}"`);
      return result;

    } catch (err) {
      this.logger.error(`JSON parse failed: ${err.message} — raw JSON: ${jsonStr.substring(0, 200)}`);
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
      const afterMarker = content.substring(
        content.indexOf(COMPLETION_MARKER) + COMPLETION_MARKER.length,
      ).trim();
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
    const allJsonMatches = [...content.matchAll(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g)];
    if (allJsonMatches.length > 0) {
      // Try from last to first — the review JSON is most likely the last one
      for (let i = allJsonMatches.length - 1; i >= 0; i--) {
        const candidate = allJsonMatches[i][0];
        // Match both expected format and deepseek-r1 format
        if (candidate.includes('"approved"') || candidate.includes('"findings"')
          || candidate.includes('"status"') || candidate.includes('"issues"')) {
          return candidate;
        }
      }
    }

    // Strategy 4: Greedy match for a large JSON object containing review keywords
    const greedyMatch = content.match(/\{[\s\S]*(?:"approved"|"status")[\s\S]*\}/);
    if (greedyMatch) return greedyMatch[0];

    return null;
  }

  /**
   * Find a valid JSON object in a string.
   */
  private findJsonObject(str: string): string | null {
    // Strip markdown code fences if present
    const stripped = str.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
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
    if (typeof parsed.approved === 'string') return parsed.approved.toLowerCase() === 'true';
    // Status string (deepseek-r1 format)
    if (parsed.status) {
      const status = String(parsed.status).toLowerCase();
      return status === 'approved' || status === 'approve' || status === 'lgtm';
    }
    // Decision string
    if (parsed.decision) {
      const decision = String(parsed.decision).toLowerCase();
      return decision === 'approve' || decision === 'approved' || decision === 'lgtm';
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
    return rawFindings
      .filter((f: any) => f && typeof f === 'object')
      .map((f: any) => ({
        severity: this.normalizeSeverity(f.severity || f.type || f.level),
        file: String(f.file ?? f.path ?? f.filename ?? 'unknown'),
        line: typeof f.line === 'number' ? f.line : (typeof f.lineNumber === 'number' ? f.lineNumber : undefined),
        message: String(f.message ?? f.description ?? f.comment ?? f.text ?? 'No details'),
        suggestion: f.suggestion ? String(f.suggestion) : (f.suggestedFix ? String(f.suggestedFix) : undefined),
      }));
  }

  private normalizeSeverity(raw: any): 'info' | 'warning' | 'critical' {
    if (!raw) return 'warning';
    const s = String(raw).toLowerCase();
    if (['critical', 'error', 'high', 'major', 'blocker'].includes(s)) return 'critical';
    if (['warning', 'warn', 'medium', 'minor'].includes(s)) return 'warning';
    return 'info';
  }

  /**
   * Fallback: analyze the review text to determine approval/findings
   * when JSON parsing fails completely.
   */
  private buildResultFromText(text: string, issueId: string, mrIid: number): ReviewResult {
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
    const summary = this.extractSummaryFromText(text) || 'Review analysis completed (parsed from text)';

    // Build synthetic findings from text analysis
    const findings: ReviewFinding[] = [];
    const findingPattern = /(?:^|\n)\s*(?:\d+\.\s*)?(?:\*\*)?(?:(?:critical|warning|info)[:\s—-]+)(.*?)(?:\n|$)/gi;
    let match: RegExpExecArray | null;
    while ((match = findingPattern.exec(text)) !== null) {
      const line = match[0].trim();
      const severity = /critical/i.test(line) ? 'critical' : /warning/i.test(line) ? 'warning' : 'info';
      findings.push({
        severity,
        file: 'unknown',
        message: match[1]?.trim() || line.substring(0, 100),
      });
    }

    const approved = hasApproved && !hasChangesRequested && criticalCount === 0;

    this.logger.log(`Text-based review: approved=${approved}, criticals=${criticalCount}, warnings=${warningCount}, findings=${findings.length}`);

    return { issueId, mrIid, approved, summary, findings };
  }

  /**
   * Extract a summary sentence from the review text.
   */
  private extractSummaryFromText(text: string): string | null {
    // Look for explicit summary section
    const summaryMatch = text.match(/(?:summary|decision|conclusion|overall)[:\s]*\n?\s*(.+?)(?:\n\n|\n(?=[#*\-]))/i);
    if (summaryMatch) {
      const cleaned = summaryMatch[1].replace(/^\*+\s*|\s*\*+$/g, '').trim();
      if (cleaned.length > 10) return cleaned.substring(0, 200);
    }

    // Look for the first substantial paragraph (skip headers like "**Review Analysis:**")
    const markerPos = text.indexOf(COMPLETION_MARKER);
    const beforeMarker = markerPos > 0 ? text.substring(0, markerPos) : text;

    // Split into paragraphs and find the first meaningful one
    const paragraphs = beforeMarker.split(/\n\n+/)
      .map(p => p.replace(/^\*+\s*|\s*\*+$/g, '').replace(/^#+\s*/, '').trim())
      .filter(p => p.length > 30 && !p.startsWith('###') && !p.startsWith('---'));

    if (paragraphs.length > 0) {
      // Use the first real paragraph as summary
      const first = paragraphs[0].split('\n')[0]; // Just the first line
      return first.substring(0, 200);
    }

    // Last resort: last sentence before JSON
    const sentences = beforeMarker.split(/[.\n]/).filter(s => s.trim().length > 20);
    if (sentences.length > 0) {
      return sentences[sentences.length - 1].replace(/^\*+\s*|\s*\*+$/g, '').trim().substring(0, 200);
    }
    return null;
  }

  // ─── Markdown Builder ────────────────────────────────────────

  private buildReviewMarkdown(review: ReviewResult): string {
    const statusEmoji = review.approved ? '✅' : '⚠️';
    const statusText = review.approved ? 'APPROVED' : 'CHANGES REQUESTED';

    const parts = [
      `## ${statusEmoji} Code Review: ${statusText}`,
      '',
      review.summary,
    ];

    if (review.findings.length > 0) {
      parts.push('', '### Findings:');
      for (const f of review.findings) {
        const icon = f.severity === 'critical' ? '🔴' : f.severity === 'warning' ? '🟡' : '🔵';
        parts.push(`${icon} **${f.severity}** — \`${f.file}${f.line ? `:${f.line}` : ''}\``);
        parts.push(`  ${f.message}`);
        if (f.suggestion) {
          parts.push(`  💡 ${f.suggestion}`);
        }
        parts.push('');
      }
    }

    parts.push('---', '_Reviewed by Code Reviewer Agent_');
    return parts.join('\n');
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
      const diffs = await this.gitlabService.getMergeRequestDiffs(gitlabProjectId, mrIid);
      if (diffs.length > 0) {
        this.logger.log(`Got ${diffs.length} diff(s) for MR !${mrIid} on attempt ${attempt}`);
        return diffs;
      }
      if (attempt < maxRetries) {
        this.logger.debug(`MR !${mrIid} has no diffs yet — waiting ${delayMs}ms (attempt ${attempt}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
    this.logger.warn(`MR !${mrIid} still has no diffs after ${maxRetries} attempts`);
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
    } catch (err) {
      this.logger.error(`Failed to mark task as failed: ${err.message}`);
    }
  }
}
