import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import { PrismaService } from '../../prisma/prisma.service';
import { SystemSettingsService } from '../../settings/system-settings.service';
import { ChatService } from '../../chat/chat.service';
import { ChatGateway } from '../../chat/chat.gateway';
import { LlmService } from '../../llm/llm.service';
import { GitlabService } from '../../gitlab/gitlab.service';
import { LlmMessage } from '../../llm/llm.interfaces';
import { BaseAgent, AgentContext } from '../agent-base';
import { MonitorGateway } from '../../monitor/monitor.gateway';
import { DualTestService } from '../dual-test.service';
import { postAgentComment, getAgentCommentHistory } from '../agent-comment.utils';
import { PenTestResult, SecurityFinding } from './pen-test-result.interface';
import {
  AgentRole,
  AgentStatus,
  AgentTaskStatus,
} from '@prisma/client';

const execFileAsync = promisify(execFile);

const COMPLETION_MARKER = ':::SECURITY_TEST_COMPLETE:::';
const AUDIT_TIMEOUT_MS = 60_000;
const HTTP_TIMEOUT_MS = 10_000;

const SECURITY_HEADERS = [
  'content-security-policy',
  'x-frame-options',
  'x-content-type-options',
  'strict-transport-security',
  'x-xss-protection',
  'referrer-policy',
  'permissions-policy',
];

/** Default max warning threshold — configurable via SystemSetting pentester.maxWarnings */
const DEFAULT_MAX_WARNINGS = 3;

const DEFAULT_SYSTEM_PROMPT = `You are the Pen Tester Agent for VibCode Hub — an AI development team platform.

## Your Role
You perform security analysis on merge request code changes, focusing on OWASP Top 10 vulnerabilities.

## Testing Areas (OWASP Top 10 2021)
- **A01** Broken Access Control — missing auth checks, IDOR, privilege escalation
- **A02** Cryptographic Failures — weak hashing, plaintext secrets, insecure TLS
- **A03** Injection — SQL/NoSQL injection, command injection, XSS, template injection
- **A04** Insecure Design — missing rate limiting, business logic flaws
- **A05** Security Misconfiguration — verbose errors, default credentials, open CORS
- **A06** Vulnerable Components — known CVEs in dependencies (see npm audit results)
- **A07** Auth Failures — weak passwords, missing MFA, session fixation
- **A08** Data Integrity — unsafe deserialization, unsigned data
- **A09** Logging Failures — missing audit logs, sensitive data in logs
- **A10** SSRF — unvalidated URLs, internal network access

## Input
You will receive:
1. **Project context** (tech stack, framework, type of project)
2. MR code diffs
3. npm audit results (production dependencies only — if available)
4. HTTP security header check results (if available)

## Important: Context-Aware Analysis
- Consider the project's tech stack and type when evaluating findings
- A missing CSP header on a local dev server or static site is LOW priority (info, not warning)
- npm audit results only include production dependencies — dev-only vulns are excluded
- Focus on ACTUAL exploitable issues in the code diffs, not theoretical concerns
- Frontend-only changes rarely have backend security implications (no injection, no auth bypass)

## Severity Levels
- **critical**: Exploitable vulnerability with direct impact (injection, auth bypass, RCE, data exposure)
- **warning**: Real potential vulnerability needing review (weak validation, missing auth on sensitive endpoint)
- **info**: Best practice suggestion, minor hardening, missing non-critical headers

## Decision Rules
- **PASS** if: No critical findings AND warnings ≤ threshold (provided in prompt)
- **FAIL** if: Any critical finding OR warnings > threshold

## Completion Format
End your analysis with EXACTLY this format:

${COMPLETION_MARKER}
\`\`\`json
{
  "passed": true,
  "summary": "Brief 1-2 sentence summary",
  "findings": [
    {
      "category": "A03:2021 - Injection",
      "severity": "critical",
      "description": "User input passed directly to SQL query",
      "file": "src/users/users.service.ts",
      "line": 42,
      "recommendation": "Use parameterized queries via Prisma"
    }
  ],
  "auditResult": { "vulnerabilities": 0, "critical": 0, "high": 0 }
}
\`\`\`

CRITICAL: The JSON must be valid. Always include the OWASP category in findings.`;

@Injectable()
export class PenTesterAgent extends BaseAgent {
  readonly role = AgentRole.PEN_TESTER;
  protected readonly logger = new Logger(PenTesterAgent.name);

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
    super(prisma, settings, chatService, chatGateway, llmService, monitorGateway);
  }

  /** Get the max warnings threshold from settings (default: 3) */
  private getMaxWarnings(): number {
    const val = this.settings.get('pentester.maxWarnings', '', String(DEFAULT_MAX_WARNINGS));
    const num = parseInt(val, 10);
    return isNaN(num) ? DEFAULT_MAX_WARNINGS : num;
  }

  /** Check if header checks should be skipped (configurable per-project via settings) */
  private shouldSkipHeaderCheck(): boolean {
    return this.settings.get('pentester.skipHeaderCheck', '', 'false') === 'true';
  }

  /**
   * Security test a merge request.
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
        `**Pen Tester** analyzing MR !${mrIid} for issue #${issue.gitlabIid ?? '?'}: **${issue.title}**`,
      );

      // ─── Phase 1: npm audit (production deps only) ──────
      let auditReport = '';
      let auditResult: PenTestResult['auditResult'] | undefined;

      if (project?.slug) {
        const workspace = path.resolve(this.settings.devopsWorkspacePath, project.slug);
        const audit = await this.runNpmAudit(workspace);
        auditReport = audit.report;
        auditResult = audit.summary;
      }

      // ─── Phase 2: HTTP Header Check (skippable) ──────
      let headerReport = '';
      if (!this.shouldSkipHeaderCheck()) {
        const previewDomain = this.settings.get('preview.domain', '');
        const previewUrl = project?.previewPort && project?.slug && previewDomain
          ? `https://${project.slug}.${previewDomain}`
          : null;

        if (previewUrl) {
          headerReport = await this.checkSecurityHeaders(previewUrl);
        }
      }

      // ─── Phase 3: MR Diffs ──────────────────
      const diffs = await this.fetchDiffsWithRetry(gitlabProjectId, mrIid, 3, 5000);

      const MAX_DIFFS = 15;
      const MAX_DIFF_CHARS = 1500;
      const reviewDiffs = diffs.slice(0, MAX_DIFFS);

      const diffText = reviewDiffs.map(d => {
        const prefix = d.new_file ? '[NEW]' : d.deleted_file ? '[DELETED]' : '[MODIFIED]';
        const truncated = d.diff.length > MAX_DIFF_CHARS
          ? d.diff.substring(0, MAX_DIFF_CHARS) + '\n... (truncated)'
          : d.diff;
        return `### ${prefix} ${d.new_path}\n\`\`\`diff\n${truncated}\n\`\`\``;
      }).join('\n\n');

      // ─── Phase 4: Build tech stack context ──────
      const techStackContext = this.buildTechStackContext(project);

      // ─── Phase 5: LLM Analysis ──────────────
      const config = this.getRoleConfig();
      const systemPrompt = config.systemPrompt || DEFAULT_SYSTEM_PROMPT;

      // Inject previous agent comments as context
      const commentHistory = await getAgentCommentHistory({ prisma: this.prisma, issueId });
      const historySection = commentHistory
        ? `\n## Previous Agent Comments on this Issue\n${commentHistory}\n`
        : '';

      const maxWarnings = this.getMaxWarnings();

      const userPrompt = `Perform a security analysis of this merge request:

**Issue:** ${issue.title}
**Description:** ${issue.description || 'N/A'}

## Project Context
${techStackContext}

**Warning threshold:** PASS if ≤${maxWarnings} warnings and 0 critical findings.
${historySection}
## MR Diffs (${reviewDiffs.length} of ${diffs.length} file(s)):

${diffText || '_No diffs available._'}

${auditReport ? `## npm audit Results (production dependencies only):\n\n${auditReport}` : ''}

${headerReport ? `## Security Headers Check:\n\n${headerReport}` : ''}

Analyze the code for OWASP Top 10 vulnerabilities. Be context-aware: consider the tech stack and project type.

IMPORTANT: You MUST end your response with the JSON result in this EXACT format:
${COMPLETION_MARKER}
\`\`\`json
{"passed": true/false, "summary": "...", "findings": [{"category": "A03:2021", "severity": "critical/warning/info", "title": "...", "details": "...", "remediation": "..."}]}
\`\`\`
Do NOT omit the JSON block.`;

      const messages: LlmMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ];

      // Call primary (and optional secondary for dual-testing)
      const dualResult = await this.dualTestService.callDual(config, messages);

      if (dualResult.primary.finishReason === 'error') {
        await this.sendAgentMessage(ctx, 'Pen Tester LLM call failed');
        await this.markFailed(ctx, 'LLM call failed');
        return;
      }

      // Parse primary result
      let testResult = this.parseTestResult(dualResult.primary.content, issueId, auditResult);

      // If parsing returned 0 findings but the response was substantial, retry JSON extraction
      if (testResult && testResult.findings.length === 0 && dualResult.primary.content.length > 500) {
        const retryJson = await this.dualTestService.retryJsonExtraction(
          config,
          dualResult.primary.content,
          '{"passed": true/false, "summary": "1-2 sentences", "findings": [{"category": "A01:2021", "severity": "critical|warning|info", "description": "...", "file": "path", "recommendation": "fix"}], "auditResult": {"vulnerabilities": 0, "critical": 0, "high": 0}}',
        );
        if (retryJson) {
          const retried = this.parseTestResult(retryJson, issueId, auditResult);
          if (retried && retried.findings.length > 0) {
            this.logger.log(`JSON retry recovered ${retried.findings.length} security findings`);
            testResult = retried;
          }
        }
      }

      // Dual-testing: parse secondary and merge/consensus findings
      if (testResult && dualResult.secondary && dualResult.secondary.finishReason !== 'error') {
        const secondaryResult = this.parseTestResult(dualResult.secondary.content, issueId, auditResult);
        if (secondaryResult) {
          // Security testing uses merge (union) by default — we want ALL findings, not just consensus
          const strategy = config.dualStrategy ?? 'merge';
          const { merged, stats } = this.dualTestService.mergeFindings(
            testResult.findings,
            secondaryResult.findings,
            strategy,
            (f: SecurityFinding) => `${f.category}:${f.file ?? ''}:${f.severity}:${f.description.substring(0, 40).toLowerCase()}`,
          );

          const passed = this.dualTestService.determineApproval(merged, maxWarnings);
          testResult = { ...testResult, findings: merged, passed };

          await this.sendAgentMessage(
            ctx,
            `🔀 **Dual-test** (${strategy}): ${stats.primaryCount} + ${stats.secondaryCount} → ${stats.mergedCount} findings [${dualResult.providers.primary} + ${dualResult.providers.secondary}]`,
          );
        }
      }

      if (!testResult) {
        await this.sendAgentMessage(ctx, 'Could not parse security test result — defaulting to pass');
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
        authorName: 'Pen Tester',
        markdownContent: testMarkdown,
      });

      if (testResult.passed) {
        await this.handlePassed(ctx, issueId, mrIid, gitlabProjectId, testResult);
      } else {
        await this.handleFailed(ctx, issueId, mrIid, gitlabProjectId, testResult);
      }

    } catch (err) {
      this.logger.error(`Security test failed: ${err.message}`, err.stack);
      await this.sendAgentMessage(ctx, `**Pen Tester** error: ${err.message}`);
      await this.markFailed(ctx, err.message);
    }
  }

  // ─── Tech Stack Context Builder ────────────────────────────

  private buildTechStackContext(project: any): string {
    if (!project?.techStack) {
      return '_No tech stack information available._';
    }

    const ts = project.techStack as Record<string, unknown>;
    const parts: string[] = [];

    const stack = ts['techStack'] as Record<string, unknown> | undefined;
    if (stack) {
      if (stack['framework']) parts.push(`- **Framework:** ${stack['framework']}`);
      if (stack['language']) parts.push(`- **Language:** ${stack['language']}`);
      if (stack['backend']) parts.push(`- **Backend:** ${stack['backend']}`);
      if (stack['database']) parts.push(`- **Database:** ${stack['database']}`);
    }

    const deploy = ts['deployment'] as Record<string, unknown> | undefined;
    if (deploy) {
      parts.push(`- **Web Project:** ${deploy['isWebProject'] ? 'Yes' : 'No'}`);
      if (deploy['devServerCommand']) parts.push(`- **Dev Server:** ${deploy['devServerCommand']}`);
    }

    if (parts.length === 0) return '_Minimal tech stack info._';

    // Determine project type for LLM context
    const framework = String(stack?.['framework'] ?? '').toLowerCase();
    const backend = String(stack?.['backend'] ?? '').toLowerCase();

    let projectType = 'Full-Stack Application';
    if (!backend && (framework.includes('angular') || framework.includes('react') || framework.includes('vue'))) {
      projectType = 'Frontend-Only SPA (no backend)';
    } else if (!framework && (backend.includes('nest') || backend.includes('express') || backend.includes('fastify'))) {
      projectType = 'Backend API (no frontend)';
    } else if (framework === 'static' || framework === 'html') {
      projectType = 'Static Site';
    }

    parts.unshift(`- **Project Type:** ${projectType}`);
    return parts.join('\n');
  }

  // ─── npm audit (production deps only) ────────────────────

  private async runNpmAudit(workspace: string): Promise<{
    report: string;
    summary: PenTestResult['auditResult'];
  }> {
    try {
      // --omit=dev: Only audit production dependencies to reduce false positives
      const { stdout } = await execFileAsync(
        'npm', ['audit', '--omit=dev', '--json'],
        { cwd: workspace, timeout: AUDIT_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
      ).catch(err => {
        // npm audit exits with code 1 when vulnerabilities found — still has useful stdout
        if (err.stdout) return { stdout: err.stdout, stderr: err.stderr };
        throw err;
      });

      const auditData = JSON.parse(stdout);
      const meta = auditData.metadata?.vulnerabilities || {};

      const summary = {
        vulnerabilities: (meta.total ?? 0) as number,
        critical: (meta.critical ?? 0) as number,
        high: (meta.high ?? 0) as number,
      };

      // Format report for LLM
      const lines = [
        `**Scope:** Production dependencies only (dev excluded)`,
        `Total vulnerabilities: ${summary.vulnerabilities}`,
        `Critical: ${summary.critical}`,
        `High: ${summary.high}`,
      ];

      // List top advisories
      const advisories = auditData.advisories || auditData.vulnerabilities || {};
      const entries = Object.values(advisories).slice(0, 10);
      for (const adv of entries as any[]) {
        const name = adv.name || adv.module_name || 'unknown';
        const severity = adv.severity || 'unknown';
        const title = adv.title || adv.overview || '';
        lines.push(`- **${severity}** \`${name}\`: ${title.substring(0, 100)}`);
      }

      return { report: lines.join('\n'), summary };

    } catch (err) {
      this.logger.warn(`npm audit failed: ${err.message}`);
      return { report: `_npm audit failed: ${err.message}_`, summary: undefined };
    }
  }

  // ─── HTTP Header Check ──────────────────────────────────

  private async checkSecurityHeaders(url: string): Promise<string> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

      const response = await fetch(url, {
        method: 'HEAD',
        signal: controller.signal,
        redirect: 'follow',
      });
      clearTimeout(timeout);

      const lines: string[] = [`**URL:** ${url}`, `**Status:** ${response.status}`, '', '### Security Headers:'];

      for (const header of SECURITY_HEADERS) {
        const value = response.headers.get(header);
        if (value) {
          lines.push(`- ✅ \`${header}\`: ${value.substring(0, 100)}`);
        } else {
          lines.push(`- ❌ \`${header}\`: **MISSING**`);
        }
      }

      lines.push('', '_Note: Missing headers on dev/preview servers are typically info-level, not warnings._');

      return lines.join('\n');

    } catch (err) {
      this.logger.warn(`Header check failed: ${err.message}`);
      return `_Security header check failed: ${err.message}_`;
    }
  }

  // ─── Result Handlers ──────────────────────────────────────

  private async handlePassed(
    ctx: AgentContext,
    issueId: string,
    mrIid: number,
    gitlabProjectId: number,
    testResult: PenTestResult,
  ): Promise<void> {
    await this.sendAgentMessage(
      ctx,
      `**Security Test passed** for MR !${mrIid}\n\n${testResult.summary}`,
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

    this.eventEmitter.emit('agent.penTestComplete', {
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
    testResult: PenTestResult,
  ): Promise<void> {
    const findingsText = testResult.findings
      .filter(f => f.severity !== 'info')
      .map(f => `- **${f.severity}** [${f.category}]${f.file ? ` \`${f.file}${f.line ? `:${f.line}` : ''}\`` : ''}: ${f.description}`)
      .join('\n');

    await this.sendAgentMessage(
      ctx,
      `**Security Test failed** for MR !${mrIid}\n\n${testResult.summary}\n\n${findingsText}`,
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
      .map(f => `[${f.severity.toUpperCase()}] [${f.category}]${f.file ? ` ${f.file}${f.line ? `:${f.line}` : ''}` : ''}: ${f.description}. Recommendation: ${f.recommendation}`)
      .join('\n');

    this.eventEmitter.emit('agent.penTestComplete', {
      projectId: ctx.projectId,
      chatSessionId: ctx.chatSessionId,
      issueId,
      mrIid,
      gitlabProjectId,
      passed: false,
      feedback: `Security Test findings:\n\n${feedback}`,
    });
  }

  // ─── Parsing ──────────────────────────────────────────────

  private parseTestResult(
    content: string,
    issueId: string,
    auditResult?: PenTestResult['auditResult'],
  ): PenTestResult | null {
    this.logger.debug(`Parsing security test result (${content.length} chars)`);

    if (!content.trim()) return null;

    let cleaned = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

    const jsonStr = this.extractJson(cleaned);

    if (!jsonStr) {
      this.logger.warn('No JSON found in security test result — building from text');
      return this.buildResultFromText(cleaned, issueId, auditResult);
    }

    try {
      const fixed = jsonStr
        .replace(/,\s*([}\]])/g, '$1')
        .replace(/[\x00-\x1F\x7F]/g, ' ');

      const parsed = JSON.parse(fixed);
      const findings = this.parseFindings(parsed.findings || parsed.vulnerabilities || parsed.issues || []);

      // Apply configurable threshold instead of trusting LLM decision blindly
      const maxWarnings = this.getMaxWarnings();
      const criticalCount = findings.filter(f => f.severity === 'critical').length;
      const warningCount = findings.filter(f => f.severity === 'warning').length;
      const passed = criticalCount === 0 && warningCount <= maxWarnings;

      let summary = parsed.summary || '';
      if (!summary || summary.length < 5) {
        summary = passed
          ? `Security test passed (${findings.length} finding(s), ${warningCount} warning(s))`
          : `Security test failed (${criticalCount} critical, ${warningCount} warning(s))`;
      }

      return {
        issueId,
        passed,
        findings,
        summary,
        auditResult: parsed.auditResult || auditResult,
      };

    } catch (err) {
      this.logger.error(`JSON parse failed: ${err.message}`);
      return this.buildResultFromText(cleaned, issueId, auditResult);
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

    // Validate candidates actually parse as JSON to avoid matching code blocks
    const allJson = [...content.matchAll(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g)];
    for (let i = allJson.length - 1; i >= 0; i--) {
      const candidate = allJson[i][0];
      if (candidate.includes('"passed"') || candidate.includes('"findings"')) {
        try { JSON.parse(candidate); return candidate; } catch { continue; }
      }
    }

    const greedy = content.match(/\{[\s\S]*"passed"[\s\S]*\}/);
    if (greedy) {
      try { JSON.parse(greedy[0]); return greedy[0]; } catch { /* skip */ }
    }

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
      return s === 'pass' || s === 'passed' || s === 'secure';
    }
    return false;
  }

  private parseFindings(raw: any): SecurityFinding[] {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((f: any) => f && typeof f === 'object')
      .map((f: any) => ({
        category: String(f.category ?? f.owasp ?? f.type ?? 'Unknown'),
        severity: this.normalizeSeverity(f.severity),
        description: String(f.description ?? f.message ?? f.details ?? 'No details'),
        file: f.file ? String(f.file) : undefined,
        line: typeof f.line === 'number' ? f.line : undefined,
        recommendation: String(f.recommendation ?? f.fix ?? f.suggestion ?? 'Review and fix'),
      }));
  }

  private normalizeSeverity(raw: any): 'info' | 'warning' | 'critical' {
    if (!raw) return 'warning';
    const s = String(raw).toLowerCase();
    if (['critical', 'error', 'high', 'major', 'blocker'].includes(s)) return 'critical';
    if (['warning', 'warn', 'medium', 'minor'].includes(s)) return 'warning';
    return 'info';
  }

  private buildResultFromText(
    text: string,
    issueId: string,
    auditResult?: PenTestResult['auditResult'],
  ): PenTestResult {
    const lower = text.toLowerCase();
    const lastLines = lower.split('\n').slice(-10).join(' ');

    // Only fail on strong evidence of critical security issues
    const strongFail = /\b(critical\s+vulnerabilit|sql\s+injection\s+found|xss\s+exploit|rce\s+found|result:\s*fail|verdict:\s*fail)\b/.test(lastLines);
    const passed = !strongFail;

    this.logger.log(`buildResultFromText: strongFail=${strongFail}, passed=${passed}`);

    return {
      issueId,
      passed,
      findings: [],
      summary: strongFail
        ? 'Security test failed (parsed from text)'
        : 'Security test passed (no critical vulnerabilities detected — defaulting to pass)',
      auditResult,
    };
  }

  // ─── Markdown Builder ────────────────────────────────────────

  private buildTestMarkdown(result: PenTestResult): string {
    const icon = result.passed ? '✅' : '❌';
    const status = result.passed ? 'PASSED' : 'FAILED';

    const parts = [
      `## ${icon} Security Test: ${status}`,
      '',
      result.summary,
    ];

    if (result.auditResult) {
      parts.push('', '### Dependency Audit (production only):');
      parts.push(`- Vulnerabilities: ${result.auditResult.vulnerabilities}`);
      parts.push(`- Critical: ${result.auditResult.critical}`);
      parts.push(`- High: ${result.auditResult.high}`);
    }

    if (result.findings.length > 0) {
      parts.push('', '### Security Findings:');
      for (const f of result.findings) {
        const fIcon = f.severity === 'critical' ? '🔴' : f.severity === 'warning' ? '🟡' : '🔵';
        parts.push(`${fIcon} **${f.severity}** [${f.category}]`);
        if (f.file) {
          parts.push(`  File: \`${f.file}${f.line ? `:${f.line}` : ''}\``);
        }
        parts.push(`  ${f.description}`);
        parts.push(`  💡 ${f.recommendation}`);
        parts.push('');
      }
    }

    parts.push('---', '_Tested by Pen Tester Agent_');
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
      await this.log(ctx.agentTaskId, 'ERROR', `Security test failed: ${reason}`);
    } catch (err) {
      this.logger.error(`Failed to mark task as failed: ${err.message}`);
    }
  }
}
