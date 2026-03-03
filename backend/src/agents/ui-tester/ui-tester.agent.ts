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
import { UiTestResult, UiTestFinding } from './ui-test-result.interface';
import { PlaywrightRunner, PageCapture, A11yResult } from './playwright-runner';
import {
  AgentRole,
  AgentStatus,
  AgentTaskStatus,
  CommentAuthorType,
} from '@prisma/client';

const COMPLETION_MARKER = ':::UI_TEST_COMPLETE:::';

const DEFAULT_SYSTEM_PROMPT = `You are the UI Tester Agent for VibCode Hub — an AI development team platform.

## Your Role
You verify the visual quality, responsiveness, accessibility, and user interaction patterns of web applications.

## Testing Areas
- **Layout**: Elements properly positioned, no overlaps, correct spacing
- **Responsive**: Works on mobile, tablet, and desktop viewports
- **Accessibility**: WCAG 2.1 AA compliance, keyboard navigation, screen reader support
- **Visual**: Consistent styling, no broken images, correct colors/fonts
- **Interaction**: Buttons clickable, forms functional, error states visible

## Severity Levels
- **critical**: Broken layout, inaccessible content, non-functional interactions
- **warning**: Minor layout issues, inconsistent spacing, missing alt texts
- **info**: Style suggestions, enhancement ideas

## Decision Rules
- **PASS** if: No critical findings AND ≤3 warnings
- **FAIL** if: Any critical finding OR >3 warnings

## Completion Format
End your analysis with EXACTLY this format:

${COMPLETION_MARKER}
\`\`\`json
{
  "passed": true,
  "summary": "Brief 1-2 sentence summary",
  "pagesChecked": 3,
  "findings": [
    {
      "type": "accessibility",
      "page": "/dashboard",
      "description": "Missing alt text on project cards",
      "severity": "warning"
    }
  ]
}
\`\`\`

CRITICAL: The JSON must be valid. "type" must be one of: layout, responsive, accessibility, visual, interaction.`;

@Injectable()
export class UiTesterAgent extends BaseAgent {
  readonly role = AgentRole.UI_TESTER;
  protected readonly logger = new Logger(UiTesterAgent.name);
  private playwrightRunner: PlaywrightRunner | null = null;
  private playwrightInitialized = false;

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
   * Lazy-initialize Playwright (optional dependency).
   */
  private async ensurePlaywright(): Promise<PlaywrightRunner | null> {
    if (this.playwrightInitialized) return this.playwrightRunner;

    this.playwrightInitialized = true;
    const runner = new PlaywrightRunner();
    const ok = await runner.init();
    if (ok) {
      this.playwrightRunner = runner;
      this.logger.log('Playwright initialized — browser testing enabled');
    }
    return this.playwrightRunner;
  }

  /**
   * Test UI for a specific issue's merge request.
   */
  async testIssue(
    ctx: AgentContext,
    issueId: string,
    mrIid: number,
    gitlabProjectId: number,
  ): Promise<void> {
    try {
      await this.updateStatus(ctx, AgentStatus.WORKING);

      // Load issue + project
      const issue = await this.prisma.issue.findUnique({
        where: { id: issueId },
      });
      if (!issue) {
        await this.sendAgentMessage(ctx, `Issue ${issueId} not found`);
        await this.markFailed(ctx, 'Issue not found');
        return;
      }

      const project = await this.prisma.project.findUnique({
        where: { id: ctx.projectId },
      });

      await this.sendAgentMessage(
        ctx,
        `**UI Tester** checking MR !${mrIid} for issue #${issue.gitlabIid ?? '?'}: **${issue.title}**`,
      );

      // Get MR diffs
      const diffs = await this.fetchDiffsWithRetry(gitlabProjectId, mrIid, 3, 5000);

      // Determine preview URL
      const previewDomain = this.settings.get('preview.domain', '');
      const previewUrl = project?.previewPort && project?.slug && previewDomain
        ? `https://${project.slug}.${previewDomain}`
        : null;

      let browserData = '';

      if (previewUrl) {
        // Playwright-based testing
        const runner = await this.ensurePlaywright();

        if (runner) {
          await this.sendAgentMessage(ctx, `Running browser tests against ${previewUrl}...`);

          // Extract routes from diffs (look for route definitions in changed files)
          const routes = this.extractRoutesFromDiffs(diffs);
          if (routes.length === 0) routes.push('/'); // Always test root

          // Capture pages
          const captures = await runner.capturePages(previewUrl, routes);

          // Accessibility check on main route
          const a11y = await runner.checkAccessibility(previewUrl, routes[0]);

          // Responsive check on main route
          const responsive = await runner.checkResponsive(previewUrl, routes[0]);

          browserData = this.formatBrowserData(captures, a11y, responsive);
        }
      }

      if (!browserData) {
        await this.sendAgentMessage(ctx, 'No preview available — running code-only UI analysis');
      }

      // Build LLM prompt
      const config = this.getRoleConfig();
      const systemPrompt = config.systemPrompt || DEFAULT_SYSTEM_PROMPT;

      const MAX_DIFFS = 20;
      const MAX_DIFF_CHARS = 2000;
      const reviewDiffs = diffs
        .filter(d => /\.(html|css|scss|tsx|jsx|ts|js|vue|svelte)$/.test(d.new_path))
        .slice(0, MAX_DIFFS);

      const diffText = reviewDiffs.map(d => {
        const prefix = d.new_file ? '[NEW]' : d.deleted_file ? '[DELETED]' : '[MODIFIED]';
        const truncated = d.diff.length > MAX_DIFF_CHARS
          ? d.diff.substring(0, MAX_DIFF_CHARS) + '\n... (truncated)'
          : d.diff;
        return `### ${prefix} ${d.new_path}\n\`\`\`diff\n${truncated}\n\`\`\``;
      }).join('\n\n');

      const userPrompt = `Analyze the UI changes in this merge request:

**Issue:** ${issue.title}
**Description:** ${issue.description || 'N/A'}
${previewUrl ? `**Preview URL:** ${previewUrl}` : ''}

## Code Changes (${reviewDiffs.length} UI-related file(s)):

${diffText || '_No UI-related files changed._'}

${browserData ? `## Browser Test Results:\n\n${browserData}` : ''}

Analyze the UI changes for layout, responsiveness, accessibility, visual quality, and interactions.`;

      const messages: LlmMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ];

      // Call LLM
      const result = await this.callLlm(messages);

      if (result.finishReason === 'error') {
        await this.sendAgentMessage(ctx, 'UI Tester LLM call failed');
        await this.markFailed(ctx, 'LLM call failed');
        return;
      }

      // Parse result
      const testResult = this.parseTestResult(result.content, issueId);

      if (!testResult) {
        await this.sendAgentMessage(ctx, 'Could not parse UI test result — defaulting to pass');
        await this.handlePassed(ctx, issueId, mrIid, gitlabProjectId, {
          issueId, passed: true, findings: [], summary: 'Parse failed — auto-passed', pagesChecked: 0,
        });
        return;
      }

      // Post GitLab comment
      await this.postTestComment(gitlabProjectId, issue.gitlabIid!, testResult);

      // Save comment locally
      await this.prisma.issueComment.create({
        data: {
          issueId,
          authorType: CommentAuthorType.AGENT,
          authorName: 'UI Tester',
          content: `UI Test: ${testResult.passed ? 'PASSED' : 'FAILED'} — ${testResult.summary}. ${testResult.findings.length} finding(s).`,
          agentTaskId: ctx.agentTaskId,
        },
      });

      if (testResult.passed) {
        await this.handlePassed(ctx, issueId, mrIid, gitlabProjectId, testResult);
      } else {
        await this.handleFailed(ctx, issueId, mrIid, gitlabProjectId, testResult);
      }

    } catch (err) {
      this.logger.error(`UI test failed: ${err.message}`, err.stack);
      await this.sendAgentMessage(ctx, `**UI Tester** error: ${err.message}`);
      await this.markFailed(ctx, err.message);
    }
  }

  // ─── Browser Data Formatting ──────────────────────────────

  private formatBrowserData(
    captures: PageCapture[],
    a11y: A11yResult | null,
    responsive: any,
  ): string {
    const parts: string[] = [];

    // Page captures (omit base64 for LLM prompt — too large)
    if (captures.length > 0) {
      parts.push('### Page Captures:');
      for (const c of captures) {
        parts.push(`**${c.route}**`);
        if (c.consoleErrors.length > 0) {
          parts.push(`- Console Errors: ${c.consoleErrors.slice(0, 5).join('; ')}`);
        } else {
          parts.push('- No console errors');
        }
        // Include a DOM summary (first 2000 chars)
        const domSummary = c.domSnapshot.substring(0, 2000);
        parts.push(`- DOM snapshot (first 2000 chars):\n\`\`\`html\n${domSummary}\n\`\`\``);
        parts.push('');
      }
    }

    // Accessibility results
    if (a11y) {
      parts.push('### Accessibility Audit:');
      parts.push(`- Route: ${a11y.route}`);
      parts.push(`- Passes: ${a11y.passes}`);
      parts.push(`- Violations: ${a11y.violations.length}`);
      for (const v of a11y.violations.slice(0, 10)) {
        parts.push(`  - **${v.impact}**: ${v.description} (${v.nodes} element(s)) — ${v.id}`);
      }
      parts.push('');
    }

    // Responsive results
    if (responsive?.captures?.length > 0) {
      parts.push('### Responsive Check:');
      for (const rc of responsive.captures) {
        parts.push(`- ${rc.viewport} (${rc.width}x${rc.height}): Screenshot captured`);
      }
      parts.push('');
    }

    return parts.join('\n');
  }

  private extractRoutesFromDiffs(diffs: any[]): string[] {
    const routes = new Set<string>();

    for (const d of diffs) {
      // Look for Angular/React route definitions
      const routeMatches = d.diff.matchAll(/path:\s*['"`]([^'"`]+)['"`]/g);
      for (const match of routeMatches) {
        const route = match[1].startsWith('/') ? match[1] : `/${match[1]}`;
        routes.add(route);
      }

      // Look for component file paths that suggest pages
      const pathMatch = d.new_path.match(/pages?\/([^/]+)/);
      if (pathMatch) {
        routes.add(`/${pathMatch[1].replace(/\.(component|page)\.(ts|tsx|vue|svelte)$/, '')}`);
      }
    }

    return [...routes].slice(0, 5); // Max 5 routes
  }

  // ─── Result Handlers ──────────────────────────────────────

  private async handlePassed(
    ctx: AgentContext,
    issueId: string,
    mrIid: number,
    gitlabProjectId: number,
    testResult: UiTestResult,
  ): Promise<void> {
    await this.sendAgentMessage(
      ctx,
      `**UI Test passed** for MR !${mrIid}\n\n${testResult.summary}`,
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

    this.eventEmitter.emit('agent.uiTestComplete', {
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
    testResult: UiTestResult,
  ): Promise<void> {
    const findingsText = testResult.findings
      .filter(f => f.severity !== 'info')
      .map(f => `- **${f.severity}** [${f.type}] ${f.page}: ${f.description}`)
      .join('\n');

    await this.sendAgentMessage(
      ctx,
      `**UI Test failed** for MR !${mrIid}\n\n${testResult.summary}\n\n${findingsText}`,
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

    const feedback = testResult.findings
      .filter(f => f.severity !== 'info')
      .map(f => `[${f.severity.toUpperCase()}] [${f.type}] ${f.page}: ${f.description}`)
      .join('\n');

    this.eventEmitter.emit('agent.uiTestComplete', {
      projectId: ctx.projectId,
      chatSessionId: ctx.chatSessionId,
      issueId,
      mrIid,
      gitlabProjectId,
      passed: false,
      feedback: `UI Test findings:\n\n${feedback}`,
    });
  }

  // ─── Parsing ──────────────────────────────────────────────

  private parseTestResult(content: string, issueId: string): UiTestResult | null {
    this.logger.debug(`Parsing UI test result (${content.length} chars)`);

    if (!content.trim()) return null;

    let cleaned = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

    const jsonStr = this.extractJson(cleaned);

    if (!jsonStr) {
      this.logger.warn('No JSON found in UI test result — building from text');
      return this.buildResultFromText(cleaned, issueId);
    }

    try {
      const fixed = jsonStr
        .replace(/,\s*([}\]])/g, '$1')
        .replace(/[\x00-\x1F\x7F]/g, ' ');

      const parsed = JSON.parse(fixed);
      const passed = this.normalizePass(parsed);
      const findings = this.parseFindings(parsed.findings || parsed.issues || []);

      let summary = parsed.summary || '';
      if (!summary || summary.length < 5) {
        summary = passed
          ? `UI test passed (${findings.length} finding(s))`
          : `UI test failed (${findings.filter(f => f.severity !== 'info').length} issue(s))`;
      }

      return {
        issueId,
        passed,
        findings,
        summary,
        pagesChecked: parsed.pagesChecked ?? 0,
      };

    } catch (err) {
      this.logger.error(`JSON parse failed: ${err.message}`);
      return this.buildResultFromText(cleaned, issueId);
    }
  }

  private extractJson(content: string): string | null {
    if (content.includes(COMPLETION_MARKER)) {
      const after = content.substring(
        content.indexOf(COMPLETION_MARKER) + COMPLETION_MARKER.length,
      ).trim();
      const json = this.findJsonObject(after);
      if (json) return json;
    }

    const fenceMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (fenceMatch) {
      const json = this.findJsonObject(fenceMatch[1]);
      if (json) return json;
    }

    const allJson = [...content.matchAll(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g)];
    for (let i = allJson.length - 1; i >= 0; i--) {
      const candidate = allJson[i][0];
      if (candidate.includes('"passed"') || candidate.includes('"findings"')) {
        return candidate;
      }
    }

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
    return false;
  }

  private parseFindings(raw: any): UiTestFinding[] {
    if (!Array.isArray(raw)) return [];
    const validTypes = ['layout', 'responsive', 'accessibility', 'visual', 'interaction'];
    return raw
      .filter((f: any) => f && typeof f === 'object')
      .map((f: any) => ({
        type: validTypes.includes(f.type) ? f.type : 'visual',
        page: String(f.page ?? f.route ?? f.url ?? '/'),
        description: String(f.description ?? f.message ?? f.details ?? 'No details'),
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

  private buildResultFromText(text: string, issueId: string): UiTestResult {
    const lower = text.toLowerCase();
    const hasFail = lower.includes('fail') || lower.includes('critical') || lower.includes('broken');
    const hasPass = lower.includes('pass') || lower.includes('looks good') || lower.includes('no issues');
    const passed = hasPass && !hasFail;

    return {
      issueId,
      passed,
      findings: [],
      summary: passed ? 'UI test passed (parsed from text)' : 'UI test failed (parsed from text)',
      pagesChecked: 0,
    };
  }

  // ─── GitLab Comment ────────────────────────────────────────

  private async postTestComment(
    gitlabProjectId: number,
    issueIid: number,
    result: UiTestResult,
  ): Promise<void> {
    const icon = result.passed ? '✅' : '❌';
    const status = result.passed ? 'PASSED' : 'FAILED';

    const parts = [
      `## ${icon} UI Test: ${status}`,
      '',
      result.summary,
      `_Pages checked: ${result.pagesChecked}_`,
    ];

    if (result.findings.length > 0) {
      parts.push('', '### Findings:');
      for (const f of result.findings) {
        const fIcon = f.severity === 'critical' ? '🔴' : f.severity === 'warning' ? '🟡' : '🔵';
        parts.push(`${fIcon} **${f.severity}** [${f.type}] — \`${f.page}\``);
        parts.push(`  ${f.description}`);
        parts.push('');
      }
    }

    parts.push('---', '_Tested by UI Tester Agent_');

    try {
      await this.gitlabService.createIssueNote(gitlabProjectId, issueIid, parts.join('\n'));
    } catch (err) {
      this.logger.warn(`Failed to post UI test comment: ${err.message}`);
    }
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
      await this.log(ctx.agentTaskId, 'ERROR', `UI test failed: ${reason}`);
    } catch (err) {
      this.logger.error(`Failed to mark task as failed: ${err.message}`);
    }
  }
}
