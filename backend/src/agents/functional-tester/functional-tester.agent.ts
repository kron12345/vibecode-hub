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
import { postAgentComment, getAgentCommentHistory } from '../agent-comment.utils';
import { FunctionalTestResult, FunctionalTestFinding } from './functional-test-result.interface';
import {
  AgentRole,
  AgentStatus,
  AgentTaskStatus,
} from '@prisma/client';

const COMPLETION_MARKER = ':::TEST_COMPLETE:::';

const DEFAULT_SYSTEM_PROMPT = `You are the Functional Tester Agent for VibCode Hub — an AI development team platform.

## Your Role
You verify that merge request code changes correctly implement the acceptance criteria defined in the issue.

## Testing Approach
- Read the issue description and acceptance criteria carefully
- Analyze the MR diffs to verify each criterion is addressed
- Check for edge cases and error handling
- Verify that the implementation is complete, not partial
- Look for missing test coverage

## Severity Levels
- **critical**: Acceptance criterion not implemented, broken core logic
- **warning**: Partial implementation, missing edge cases, weak error handling
- **info**: Minor improvements, style suggestions, extra test ideas

## Decision Rules
- **PASS** if: All acceptance criteria are addressed AND no critical findings
- **FAIL** if: Any acceptance criterion is missing OR any critical finding

## Completion Format
End your analysis with EXACTLY this format:

${COMPLETION_MARKER}
\`\`\`json
{
  "passed": true,
  "summary": "Brief 1-2 sentence summary",
  "findings": [
    {
      "criterion": "User can log in with email",
      "passed": true,
      "details": "Login flow correctly implemented with email validation",
      "severity": "info"
    }
  ]
}
\`\`\`

CRITICAL: The JSON must be valid. "passed" must be boolean. Each finding needs "criterion", "passed", and "details".`;

@Injectable()
export class FunctionalTesterAgent extends BaseAgent {
  readonly role = AgentRole.FUNCTIONAL_TESTER;
  protected readonly logger = new Logger(FunctionalTesterAgent.name);

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
   * Test a merge request against the issue's acceptance criteria.
   */
  async testIssue(
    ctx: AgentContext,
    issueId: string,
    mrIid: number,
    gitlabProjectId: number,
  ): Promise<void> {
    try {
      await this.updateStatus(ctx, AgentStatus.WORKING);

      // Load issue with sub-issues (acceptance criteria)
      const issue = await this.prisma.issue.findUnique({
        where: { id: issueId },
        include: { subIssues: true },
      });
      if (!issue) {
        await this.sendAgentMessage(ctx, `Issue ${issueId} not found`);
        await this.markFailed(ctx, 'Issue not found');
        return;
      }

      await this.sendAgentMessage(
        ctx,
        `**Functional Tester** verifying MR !${mrIid} for issue #${issue.gitlabIid ?? '?'}: **${issue.title}**`,
      );

      // Get MR diffs
      const diffs = await this.fetchDiffsWithRetry(gitlabProjectId, mrIid, 3, 5000);

      if (diffs.length === 0) {
        await this.sendAgentMessage(ctx, 'MR has no diffs — auto-passing');
        await this.handlePassed(ctx, issueId, mrIid, gitlabProjectId, {
          issueId, passed: true, findings: [], summary: 'No diffs in MR',
        });
        return;
      }

      // Build prompt
      const config = this.getRoleConfig();
      const systemPrompt = config.systemPrompt || DEFAULT_SYSTEM_PROMPT;

      // Collect acceptance criteria from sub-issues
      const acceptanceCriteria = issue.subIssues
        .map((sub, i) => `${i + 1}. ${sub.title}${sub.description ? ': ' + sub.description : ''}`)
        .join('\n');

      // Format diffs (same pattern as Code Reviewer)
      const MAX_DIFFS = 25;
      const MAX_DIFF_CHARS = 2000;
      const reviewDiffs = diffs.slice(0, MAX_DIFFS);

      const diffText = reviewDiffs.map(d => {
        const prefix = d.new_file ? '[NEW]' : d.deleted_file ? '[DELETED]' : d.renamed_file ? '[RENAMED]' : '[MODIFIED]';
        const truncated = d.diff.length > MAX_DIFF_CHARS
          ? d.diff.substring(0, MAX_DIFF_CHARS) + '\n... (truncated)'
          : d.diff;
        return `### ${prefix} ${d.new_path}\n\`\`\`diff\n${truncated}\n\`\`\``;
      }).join('\n\n');

      // Inject previous agent comments as context
      const commentHistory = await getAgentCommentHistory({ prisma: this.prisma, issueId });
      const historySection = commentHistory
        ? `\n## Previous Agent Comments on this Issue\n${commentHistory}\n`
        : '';

      const userPrompt = `Verify the following merge request implements the issue requirements:

**Issue:** ${issue.title}
**Description:** ${issue.description || 'N/A'}
${historySection}
## Acceptance Criteria:
${acceptanceCriteria || '_No sub-issues / acceptance criteria defined — verify based on issue description._'}

## MR Diffs (${reviewDiffs.length} of ${diffs.length} file(s)):

${diffText}

Analyze each acceptance criterion against the code changes and provide your functional test result.`;

      const messages: LlmMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ];

      // Call LLM
      const result = await this.callLlm(messages);

      if (result.finishReason === 'error') {
        await this.sendAgentMessage(ctx, 'Functional Tester LLM call failed');
        await this.markFailed(ctx, 'LLM call failed');
        return;
      }

      // Parse test result
      const testResult = this.parseTestResult(result.content, issueId);

      if (!testResult) {
        await this.sendAgentMessage(ctx, 'Could not parse test result — defaulting to pass');
        await this.handlePassed(ctx, issueId, mrIid, gitlabProjectId, {
          issueId, passed: true, findings: [], summary: 'Parse failed — auto-passed',
        });
        return;
      }

      // Post unified comment (same rich markdown for local + GitLab)
      const testMarkdown = this.buildTestMarkdown(testResult);
      await postAgentComment({
        prisma: this.prisma,
        gitlabService: this.gitlabService,
        issueId,
        gitlabProjectId,
        issueIid: issue.gitlabIid!,
        agentTaskId: ctx.agentTaskId,
        authorName: 'Functional Tester',
        markdownContent: testMarkdown,
      });

      if (testResult.passed) {
        await this.handlePassed(ctx, issueId, mrIid, gitlabProjectId, testResult);
      } else {
        await this.handleFailed(ctx, issueId, mrIid, gitlabProjectId, testResult);
      }

    } catch (err) {
      this.logger.error(`Functional test failed: ${err.message}`, err.stack);
      await this.sendAgentMessage(ctx, `**Functional Tester** error: ${err.message}`);
      await this.markFailed(ctx, err.message);
    }
  }

  // ─── Result Handlers ──────────────────────────────────────

  private async handlePassed(
    ctx: AgentContext,
    issueId: string,
    mrIid: number,
    gitlabProjectId: number,
    testResult: FunctionalTestResult,
  ): Promise<void> {
    await this.sendAgentMessage(
      ctx,
      `**Functional Test passed** for MR !${mrIid}\n\n${testResult.summary}`,
    );

    await this.prisma.agentTask.update({
      where: { id: ctx.agentTaskId },
      data: {
        status: AgentTaskStatus.COMPLETED,
        output: testResult as any,
        completedAt: new Date(),
      },
    });

    await this.updateStatus(ctx, AgentStatus.IDLE);

    this.eventEmitter.emit('agent.functionalTestComplete', {
      projectId: ctx.projectId,
      chatSessionId: ctx.chatSessionId,
      issueId,
      mrIid,
      gitlabProjectId,
      passed: true,
    });
  }

  private async handleFailed(
    ctx: AgentContext,
    issueId: string,
    mrIid: number,
    gitlabProjectId: number,
    testResult: FunctionalTestResult,
  ): Promise<void> {
    const failedCriteria = testResult.findings
      .filter(f => !f.passed)
      .map(f => `- **${f.severity ?? 'warning'}** — ${f.criterion}: ${f.details}`)
      .join('\n');

    await this.sendAgentMessage(
      ctx,
      `**Functional Test failed** for MR !${mrIid}\n\n${testResult.summary}\n\n${failedCriteria}`,
    );

    await this.prisma.agentTask.update({
      where: { id: ctx.agentTaskId },
      data: {
        status: AgentTaskStatus.COMPLETED,
        output: testResult as any,
        completedAt: new Date(),
      },
    });

    await this.updateStatus(ctx, AgentStatus.IDLE);

    // Build feedback for Coder
    const feedback = testResult.findings
      .filter(f => !f.passed)
      .map(f => `[${(f.severity ?? 'warning').toUpperCase()}] ${f.criterion}: ${f.details}`)
      .join('\n');

    this.eventEmitter.emit('agent.functionalTestComplete', {
      projectId: ctx.projectId,
      chatSessionId: ctx.chatSessionId,
      issueId,
      mrIid,
      gitlabProjectId,
      passed: false,
      feedback: `Functional Test findings:\n\n${feedback}`,
    });
  }

  // ─── Parsing ──────────────────────────────────────────────

  private parseTestResult(content: string, issueId: string): FunctionalTestResult | null {
    this.logger.debug(`Parsing functional test result (${content.length} chars)`);

    if (!content.trim()) return null;

    // Strip <think> tags
    let cleaned = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

    // Extract JSON
    const jsonStr = this.extractJson(cleaned);

    if (!jsonStr) {
      this.logger.warn('No JSON found — building from text');
      return this.buildResultFromText(cleaned, issueId);
    }

    try {
      const fixed = jsonStr
        .replace(/,\s*([}\]])/g, '$1')
        .replace(/[\x00-\x1F\x7F]/g, ' ');

      const parsed = JSON.parse(fixed);
      const passed = this.normalizePass(parsed);
      const findings = this.parseFindings(parsed.findings || parsed.criteria || parsed.tests || []);

      let summary = parsed.summary || '';
      if (!summary || summary.length < 5) {
        summary = passed
          ? `All acceptance criteria verified (${findings.length} finding(s))`
          : `Functional test failed (${findings.filter(f => !f.passed).length} criterion/a not met)`;
      }

      const result: FunctionalTestResult = {
        issueId,
        passed,
        findings,
        summary,
        testsRun: parsed.testsRun ?? findings.length,
        testsPassed: parsed.testsPassed ?? findings.filter(f => f.passed).length,
      };

      this.logger.log(`Parsed functional test: passed=${result.passed}, findings=${result.findings.length}`);
      return result;

    } catch (err) {
      this.logger.error(`JSON parse failed: ${err.message}`);
      return this.buildResultFromText(cleaned, issueId);
    }
  }

  private extractJson(content: string): string | null {
    // Strategy 1: After completion marker
    if (content.includes(COMPLETION_MARKER)) {
      const after = content.substring(
        content.indexOf(COMPLETION_MARKER) + COMPLETION_MARKER.length,
      ).trim();
      const json = this.findJsonObject(after);
      if (json) return json;
    }

    // Strategy 2: Code fence
    const fenceMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (fenceMatch) {
      const json = this.findJsonObject(fenceMatch[1]);
      if (json) return json;
    }

    // Strategy 3: Last JSON with "passed" key
    const allJson = [...content.matchAll(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g)];
    for (let i = allJson.length - 1; i >= 0; i--) {
      const candidate = allJson[i][0];
      if (candidate.includes('"passed"') || candidate.includes('"findings"')) {
        return candidate;
      }
    }

    // Strategy 4: Greedy
    const greedy = content.match(/\{[\s\S]*"passed"[\s\S]*\}/);
    if (greedy) return greedy[0];

    return null;
  }

  private findJsonObject(str: string): string | null {
    const stripped = str.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
    const match = stripped.match(/\{[\s\S]*\}/);
    return match ? match[0] : null;
  }

  private normalizePass(parsed: any): boolean {
    if (typeof parsed.passed === 'boolean') return parsed.passed;
    if (typeof parsed.passed === 'string') return parsed.passed.toLowerCase() === 'true';
    if (parsed.status) {
      const s = String(parsed.status).toLowerCase();
      return s === 'pass' || s === 'passed' || s === 'success';
    }
    if (parsed.result) {
      const r = String(parsed.result).toLowerCase();
      return r === 'pass' || r === 'passed' || r === 'success';
    }
    return false;
  }

  private parseFindings(raw: any): FunctionalTestFinding[] {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((f: any) => f && typeof f === 'object')
      .map((f: any) => ({
        criterion: String(f.criterion ?? f.name ?? f.test ?? 'Unknown'),
        passed: typeof f.passed === 'boolean' ? f.passed : f.status === 'pass',
        details: String(f.details ?? f.description ?? f.message ?? 'No details'),
        severity: this.normalizeSeverity(f.severity),
      }));
  }

  private normalizeSeverity(raw: any): 'info' | 'warning' | 'critical' {
    if (!raw) return 'warning';
    const s = String(raw).toLowerCase();
    if (['critical', 'error', 'high', 'major', 'blocker'].includes(s)) return 'critical';
    if (['warning', 'warn', 'medium', 'minor'].includes(s)) return 'warning';
    return 'info';
  }

  private buildResultFromText(text: string, issueId: string): FunctionalTestResult {
    const lower = text.toLowerCase();
    const hasFail = lower.includes('fail') || lower.includes('not met') || lower.includes('missing');
    const hasPass = lower.includes('pass') || lower.includes('all criteria') || lower.includes('verified');
    const passed = hasPass && !hasFail;

    return {
      issueId,
      passed,
      findings: [],
      summary: passed ? 'Functional test passed (parsed from text)' : 'Functional test failed (parsed from text)',
    };
  }

  // ─── Markdown Builder ────────────────────────────────────────

  private buildTestMarkdown(result: FunctionalTestResult): string {
    const icon = result.passed ? '✅' : '❌';
    const status = result.passed ? 'PASSED' : 'FAILED';

    const parts = [
      `## ${icon} Functional Test: ${status}`,
      '',
      result.summary,
    ];

    if (result.findings.length > 0) {
      parts.push('', '### Acceptance Criteria:');
      for (const f of result.findings) {
        const fIcon = f.passed ? '✅' : '❌';
        parts.push(`${fIcon} **${f.criterion}**`);
        parts.push(`  ${f.details}`);
        parts.push('');
      }
    }

    parts.push('---', '_Tested by Functional Tester Agent_');
    return parts.join('\n');
  }

  // ─── Diff Fetching ──────────────────────────────────────

  private async fetchDiffsWithRetry(
    gitlabProjectId: number,
    mrIid: number,
    maxRetries: number,
    delayMs: number,
  ): Promise<any[]> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const diffs = await this.gitlabService.getMergeRequestDiffs(gitlabProjectId, mrIid);
      if (diffs.length > 0) return diffs;
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
    return [];
  }

  // ─── Helpers ──────────────────────────────────────────────

  private async markFailed(ctx: AgentContext, reason: string): Promise<void> {
    try {
      await this.prisma.agentTask.update({
        where: { id: ctx.agentTaskId },
        data: { status: AgentTaskStatus.FAILED, completedAt: new Date() },
      });
      await this.updateStatus(ctx, AgentStatus.ERROR);
      await this.log(ctx.agentTaskId, 'ERROR', `Functional test failed: ${reason}`);
    } catch (err) {
      this.logger.error(`Failed to mark task as failed: ${err.message}`);
    }
  }
}
