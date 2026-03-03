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
import { ReviewResult, ReviewFinding } from './review-result.interface';
import {
  AgentRole,
  AgentStatus,
  AgentTaskStatus,
  IssueStatus,
  CommentAuthorType,
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

      const diffText = diffs.map(d => {
        const prefix = d.new_file ? '[NEW]' : d.deleted_file ? '[DELETED]' : d.renamed_file ? '[RENAMED]' : '[MODIFIED]';
        return `### ${prefix} ${d.new_path}\n\`\`\`diff\n${d.diff.substring(0, 3000)}\n\`\`\``;
      }).join('\n\n');

      const userPrompt = `Review the following merge request:

**Issue:** ${issue.title}
**Description:** ${issue.description || 'N/A'}

## MR Diffs (${diffs.length} file(s)):

${diffText}

Provide your review analysis and end with the completion marker and JSON result.`;

      const messages: LlmMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ];

      // Call LLM
      const result = await this.callLlm(messages);

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

      // Post review as GitLab comment
      await this.postReviewComment(gitlabProjectId, issue.gitlabIid!, reviewResult);

      // Save comment to local DB
      await this.prisma.issueComment.create({
        data: {
          issueId,
          authorType: CommentAuthorType.AGENT,
          authorName: 'Code Reviewer',
          content: `Review: ${reviewResult.approved ? 'APPROVED' : 'CHANGES REQUESTED'} — ${reviewResult.summary}. ${reviewResult.findings.length} finding(s).`,
          agentTaskId: ctx.agentTaskId,
        },
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
    await this.prisma.issue.update({
      where: { id: issueId },
      data: { status: IssueStatus.TESTING },
    });

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
    await this.prisma.issue.update({
      where: { id: issueId },
      data: { status: IssueStatus.IN_PROGRESS },
    });

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

    // Build feedback for Coder
    const feedback = reviewResult.findings
      .map(f => `[${f.severity.toUpperCase()}] ${f.file}${f.line ? `:${f.line}` : ''}: ${f.message}${f.suggestion ? ` → ${f.suggestion}` : ''}`)
      .join('\n');

    this.eventEmitter.emit('agent.reviewChangesRequested', {
      projectId: ctx.projectId,
      chatSessionId: ctx.chatSessionId,
      issueId,
      feedback: `Code Review findings:\n\n${feedback}`,
    });
  }

  // ─── Parsing ──────────────────────────────────────────────

  private parseReviewResult(content: string, issueId: string, mrIid: number): ReviewResult | null {
    try {
      let jsonPart = content.includes(COMPLETION_MARKER)
        ? content.substring(content.indexOf(COMPLETION_MARKER) + COMPLETION_MARKER.length)
        : content;

      // Strip thinking tags
      jsonPart = jsonPart.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

      const jsonMatch = jsonPart.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      let jsonStr = jsonMatch[0];
      jsonStr = jsonStr.replace(/,\s*([}\]])/g, '$1');

      const parsed = JSON.parse(jsonStr);

      return {
        issueId,
        mrIid,
        approved: !!parsed.approved,
        summary: parsed.summary ?? 'No summary provided',
        findings: (parsed.findings ?? []).map((f: any) => ({
          severity: ['info', 'warning', 'critical'].includes(f.severity) ? f.severity : 'info',
          file: f.file ?? 'unknown',
          line: f.line ?? undefined,
          message: f.message ?? 'No message',
          suggestion: f.suggestion ?? undefined,
        })),
      };
    } catch (err) {
      this.logger.error(`Failed to parse review result: ${err.message}`);
      return null;
    }
  }

  // ─── GitLab Comment ────────────────────────────────────────

  private async postReviewComment(
    gitlabProjectId: number,
    issueIid: number,
    review: ReviewResult,
  ): Promise<void> {
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

    try {
      await this.gitlabService.createIssueNote(
        gitlabProjectId,
        issueIid,
        parts.join('\n'),
      );
    } catch (err) {
      this.logger.warn(`Failed to post review comment: ${err.message}`);
    }
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
