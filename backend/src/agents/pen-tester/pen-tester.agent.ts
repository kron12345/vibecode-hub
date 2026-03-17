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
import { McpAgentLoopService } from '../../mcp/mcp-agent-loop.service';
import { McpRegistryService } from '../../mcp/mcp-registry.service';
import { DualTestService } from '../dual-test.service';
import { postAgentComment, getAgentCommentHistory, extractLastAgentFindings } from '../agent-comment.utils';
import {
  postFindingsAsThreads,
  getUnresolvedThreads,
  resolveThreads,
  buildIssueSummaryWithThreadLinks,
  FindingForThread,
} from '../finding-thread.utils';
import {
  buildArchitectScopeGuardSection,
  extractArchitectOutOfScopeItems,
  filterOutOfScopeFindings,
} from '../agent-scope.utils';
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
You have access to MCP tools including filesystem access and a shell to run real security scanning tools.

## Testing Approach
1. **Read the MR diffs** to understand what was changed
2. **Use filesystem tools** to read the full source files for context
3. **Run security scanning tools** to find real vulnerabilities:
   - \`semgrep --config auto --json <path>\` — SAST pattern-based code analysis
   - \`trivy fs --scanners vuln,secret,misconfig --format json <path>\` — Filesystem vulnerability + secret scanning
   - \`npm audit --omit=dev --json\` — Dependency vulnerability audit (Node.js projects)
   - \`nuclei -t cves/ -t exposures/ -t misconfiguration/ -target <url>\` — Template-based vuln scanning (if preview URL available)
   - \`gitleaks detect --source <path> --report-format json\` — Secret detection in git history
   - \`nmap -sV -sC -p- <host>\` — Port/service scanning (if preview URL available)
4. **Analyze findings** from tools + code review combined
5. **Produce the final verdict** with all findings

## Shell Commands You Should Try
- **SAST**: \`semgrep --config auto --json .\` (run from workspace root)
- **Dependencies**: \`npm audit --omit=dev --json\` or \`mvn dependency:tree\`
- **Secrets**: \`trivy fs --scanners secret --format json .\`
- **Misconfig**: \`trivy fs --scanners misconfig --format json .\`
- **General**: \`ls\`, \`cat\`, \`find\`, \`grep -r "password\\|secret\\|token\\|api.key" --include="*.ts" --include="*.js"\`

## Testing Areas (OWASP Top 10 2021)
- **A01** Broken Access Control — missing auth checks, IDOR, privilege escalation
- **A02** Cryptographic Failures — weak hashing, plaintext secrets, insecure TLS
- **A03** Injection — SQL/NoSQL injection, command injection, XSS, template injection
- **A04** Insecure Design — missing rate limiting, business logic flaws
- **A05** Security Misconfiguration — verbose errors, default credentials, open CORS
- **A06** Vulnerable Components — known CVEs in dependencies (use npm audit / trivy)
- **A07** Auth Failures — weak passwords, missing MFA, session fixation
- **A08** Data Integrity — unsafe deserialization, unsigned data
- **A09** Logging Failures — missing audit logs, sensitive data in logs
- **A10** SSRF — unvalidated URLs, internal network access

## IMPORTANT: Read-Only — Do NOT Modify Code
You may READ files and RUN security tools, but do NOT edit or create source files. Your job is to TEST, not to fix.

## Important: Context-Aware Analysis
- Consider the project's tech stack and type when evaluating findings
- A missing CSP header on a local dev server or static site is LOW priority (info, not warning)
- Focus on ACTUAL exploitable issues, not theoretical concerns
- Frontend-only changes rarely have backend security implications
- Verify findings from automated tools — filter out false positives before reporting
- For auth-related findings: verify the SPECIFIC attack vector exists given the token issuer, audience configuration, and verification settings in the current code
- A finding is only "critical" if you can describe a concrete exploit scenario with steps

## Expectation Pattern (Anti-Loop Protocol)
You are part of an iterative test pipeline. To prevent infinite fix loops:
1. **Review Previous Round:** If "Previous Agent Comments" exist, find YOUR OWN previous security findings first. Check the CURRENT code to determine if each was addressed.
2. **Classify Each Previous Finding:**
   - \`resolved\`: Fixed correctly. Report in \`resolvedFromPrevious\`. Do NOT re-report.
   - \`unresolved\`: Not addressed. Carry forward with the EXACT SAME description + \`persistsSinceRound\`.
   - \`blocked\`: Cannot verify without runtime. NOT a FAIL reason on its own.
3. **Mandatory Expectations:** For every critical/warning finding, \`expectedFix\` MUST contain the CONCRETE secure code pattern — not "add validation" but the actual code that should exist.
4. **Exploit Scenario Required:** Each critical finding MUST include \`exploitScenario\` describing the concrete attack steps. No scenario = downgrade to warning.
5. **No Oscillation:** Do NOT oscillate between different phrasings of the same issue across rounds. If you said "Missing aud validation" in round 1, do NOT say "JWT audience not checked" in round 2.
6. **Fix Evaluation:** If the Coder's fix attempt is close but wrong, describe precisely what is STILL MISSING — referencing the specific line and what you see vs. what should be there.

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
  "roundNumber": 1,
  "resolvedFromPrevious": [
    {
      "category": "A03:2021 - Injection",
      "description": "Previously reported SQL injection",
      "resolvedBy": "Now uses Prisma parameterized query"
    }
  ],
  "findings": [
    {
      "category": "A03:2021 - Injection",
      "severity": "critical",
      "description": "User input passed directly to SQL query",
      "file": "src/users/users.service.ts",
      "line": 42,
      "recommendation": "Use parameterized queries via Prisma",
      "expectedFix": "Replace raw SQL with: prisma.user.findMany({ where: { name: { contains: input } } })",
      "exploitScenario": "Attacker sends name=' OR 1=1-- to /api/users?search= and dumps all users",
      "verificationMethod": "Read users.service.ts line 42 — raw string concatenation in SQL query",
      "persistsSinceRound": null,
      "status": "new"
    }
  ],
  "auditResult": { "vulnerabilities": 0, "critical": 0, "high": 0 }
}
\`\`\`

CRITICAL: The JSON must be valid. Always include the OWASP category in findings. "status" must be "new", "resolved", "unresolved", or "blocked".`;

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
    private readonly mcpAgentLoop: McpAgentLoopService,
    private readonly mcpRegistry: McpRegistryService,
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
        const workspace = await this.resolveWorkspace(project.slug, ctx.chatSessionId);
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
      const outOfScopeItems = extractArchitectOutOfScopeItems(commentHistory);
      const scopeGuardSection = buildArchitectScopeGuardSection(outOfScopeItems);

      const maxWarnings = this.getMaxWarnings();

      // Build structured previous findings section (Expectation Pattern memory)
      const previousFindings = extractLastAgentFindings(commentHistory, 'Pen Tester');
      const previousFindingsSection = previousFindings.length > 0
        ? `\n## YOUR Previous Security Findings — Re-Evaluate Each One\n${previousFindings.map((f, i) =>
            `${i + 1}. [${(f.severity ?? 'warning').toUpperCase()}] ${f.file ? `\`${f.file}\`: ` : ''}${f.message}\n   Expected fix: ${f.expectedFix ?? f.suggestion ?? 'not specified'}\n   → NOW CHECK: is this vulnerability still present in the current code?`
          ).join('\n')}\n\nFor each finding above: if fixed, report in \`resolvedFromPrevious\`. If still present, carry forward with SAME description.\n`
        : '';

      const userPrompt = `Perform a security analysis of this merge request${previousFindings.length > 0 ? ' (Re-test after fix attempt)' : ''}:

**Issue:** ${issue.title}
**Description:** ${issue.description || 'N/A'}

## Project Context
${techStackContext}

**Warning threshold:** PASS if ≤${maxWarnings} warnings and 0 critical findings.
${previousFindingsSection}${historySection}
${scopeGuardSection}
## MR Diffs (${reviewDiffs.length} of ${diffs.length} file(s)):

${diffText || '_No diffs available._'}

${auditReport ? `## npm audit Results (production dependencies only):\n\n${auditReport}` : ''}

${headerReport ? `## Security Headers Check:\n\n${headerReport}` : ''}

${previousFindings.length > 0
  ? 'IMPORTANT: First address each item in "YOUR Previous Security Findings" above, then check for new vulnerabilities.'
  : 'Analyze the code for OWASP Top 10 vulnerabilities. Be context-aware: consider the tech stack and project type.'}

IMPORTANT: You MUST end your response with the JSON result in this EXACT format:
${COMPLETION_MARKER}
\`\`\`json
{"passed": true/false, "summary": "...", "roundNumber": 1, "findings": [{"category": "A03:2021", "severity": "critical/warning/info", "description": "...", "file": "path", "expectedFix": "...", "exploitScenario": "...", "status": "new/unresolved/blocked"}]}
\`\`\`
Do NOT omit the JSON block.`;

      // Resolve workspace for MCP agent loop
      const workspace = project?.slug
        ? await this.resolveWorkspace(project.slug, ctx.chatSessionId)
        : '';

      // Try MCP agent loop (with shell + security tools) if workspace exists
      let resultContent: string;

      const mcpServers = workspace
        ? await this.mcpRegistry.resolveServersForRole(
            AgentRole.PEN_TESTER,
            { workspace, allowedPaths: [workspace], projectId: ctx.projectId },
          )
        : [];

      if (mcpServers.length > 0 && workspace) {
        this.logger.log(`Using MCP agent loop with ${mcpServers.length} servers (workspace: ${workspace})`);
        await this.sendAgentMessage(ctx, `Running security analysis with shell access (${mcpServers.length} MCP tools — semgrep, trivy, etc.)...`);

        const mcpResult = await this.mcpAgentLoop.run({
          provider: config.provider,
          model: config.model,
          systemPrompt,
          userPrompt,
          mcpServers,
          maxIterations: 25,
          temperature: config.parameters.temperature,
          maxTokens: config.parameters.maxTokens,
          agentTaskId: ctx.agentTaskId,
          cwd: workspace,
        });

        if (mcpResult.finishReason === 'error') {
          await this.sendAgentMessage(ctx, 'Pen Tester MCP loop failed');
          await this.markFailed(ctx, `MCP agent loop failed: ${mcpResult.errorMessage ?? 'unknown error'}`);
          return;
        }

        resultContent = mcpResult.content;
        this.logger.log(`MCP loop: ${mcpResult.iterations} iterations, ${mcpResult.toolCallsExecuted} tool calls`);
      } else {
        // Fallback: dual LLM call (no shell access)
        const messages: LlmMessage[] = [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ];

        const dualResult = await this.dualTestService.callDual(config, messages);

        if (dualResult.primary.finishReason === 'error') {
          await this.sendAgentMessage(ctx, 'Pen Tester LLM call failed');
          await this.markFailed(ctx, `LLM call failed: ${dualResult.primary.errorMessage ?? 'unknown error'}`);
          return;
        }

        resultContent = dualResult.primary.content;

        // Dual-testing: parse secondary and merge/consensus findings
        if (dualResult.secondary && dualResult.secondary.finishReason !== 'error') {
          const primaryResult = this.parseTestResult(dualResult.primary.content, issueId, auditResult);
          const secondaryResult = this.parseTestResult(dualResult.secondary.content, issueId, auditResult);
          if (primaryResult && secondaryResult) {
            const strategy = config.dualStrategy ?? 'merge';
            const { merged, stats } = this.dualTestService.mergeFindings(
              primaryResult.findings,
              secondaryResult.findings,
              strategy,
              (f: SecurityFinding) => `${f.category}:${f.file ?? ''}:${f.severity}:${f.description.substring(0, 40).toLowerCase()}`,
            );

            const passed = this.dualTestService.determineApproval(merged, maxWarnings);
            const mergedTestResult: PenTestResult = { ...primaryResult, findings: merged, passed };
            const scopedMergedResult = this.applyArchitectScopeFilter(mergedTestResult, outOfScopeItems, maxWarnings);

            await this.sendAgentMessage(
              ctx,
              `🔀 **Dual-test** (${strategy}): ${stats.primaryCount} + ${stats.secondaryCount} → ${stats.mergedCount} findings [${dualResult.providers.primary} + ${dualResult.providers.secondary}]`,
            );

            // Rule-based override: critical findings → always fail
            const critCount = scopedMergedResult.findings.filter(f => f.severity === 'critical').length;
            if (scopedMergedResult.passed && critCount > 0) {
              scopedMergedResult.passed = false;
              scopedMergedResult.summary = `[OVERRIDE] ${critCount} critical finding(s) — auto-failed. ${scopedMergedResult.summary}`;
            }

            const testMarkdown = this.buildTestMarkdown(scopedMergedResult);
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

            if (scopedMergedResult.passed) {
              await this.handlePassed(ctx, issueId, mrIid, gitlabProjectId, scopedMergedResult);
            } else {
              await this.handleFailed(ctx, issueId, mrIid, gitlabProjectId, scopedMergedResult);
            }
            return;
          }
        }
      }

      // Parse result (MCP path or single-LLM fallback)
      let testResult = this.parseTestResult(resultContent, issueId, auditResult);

      // If parsing returned 0 findings but the response was substantial, retry JSON extraction
      if (testResult && testResult.findings.length === 0 && resultContent.length > 500) {
        const retryJson = await this.dualTestService.retryJsonExtraction(
          config,
          resultContent,
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

      // Retry full parse failure
      if (!testResult && resultContent.length > 500) {
        const retryJson = await this.dualTestService.retryJsonExtraction(
          config,
          resultContent,
          '{"passed": true/false, "summary": "1-2 sentences", "findings": [{"category": "A01:2021", "severity": "critical|warning|info", "description": "...", "file": "path", "recommendation": "fix"}], "auditResult": {"vulnerabilities": 0, "critical": 0, "high": 0}}',
        );
        if (retryJson) {
          testResult = this.parseTestResult(retryJson, issueId, auditResult);
          if (testResult) {
            this.logger.log(`JSON retry recovered full security result (${testResult.findings.length} findings)`);
          }
        }
      }

      if (!testResult) {
        await this.sendAgentMessage(ctx, 'Could not parse security test result — defaulting to pass');
        await this.handlePassed(ctx, issueId, mrIid, gitlabProjectId, {
          issueId, passed: true, findings: [], summary: 'Parse failed — auto-passed',
        });
        return;
      }

      // Enforce Architect out-of-scope constraints server-side to avoid false FAIL loops.
      testResult = this.applyArchitectScopeFilter(testResult, outOfScopeItems, maxWarnings);

      // Rule-based override: critical findings → always fail, regardless of LLM opinion
      const criticalCount = testResult.findings.filter(f => f.severity === 'critical').length;
      const warningCount = testResult.findings.filter(f => f.severity === 'warning').length;
      if (testResult.passed && criticalCount > 0) {
        this.logger.warn(`Pen Tester LLM said passed but found ${criticalCount} critical + ${warningCount} warning findings — overriding to FAIL`);
        testResult.passed = false;
        testResult.summary = `[OVERRIDE] ${criticalCount} critical finding(s) detected — auto-failed. ${testResult.summary}`;
      }

      // ─── Finding Threads: Post findings as MR discussion threads ───
      const activeFindings = testResult.findings.filter(f => f.severity !== 'info');
      const findingsForThreads: FindingForThread[] = activeFindings.map(f => {
        const parts = [`**${f.severity.toUpperCase()}** [${f.category}]`, '', f.description];
        if (f.file) parts.push('', `**File:** \`${f.file}${f.line ? `:${f.line}` : ''}\``);
        if (f.expectedFix) parts.push('', `**Expected Fix:** ${f.expectedFix}`);
        if (f.exploitScenario) parts.push('', `**Exploit Scenario:** ${f.exploitScenario}`);
        parts.push('', `**Recommendation:** ${f.recommendation}`);
        return {
          severity: f.severity,
          message: `[${f.category}] ${f.description.substring(0, 80)}`,
          file: f.file,
          line: f.line,
          threadBody: parts.join('\n'),
        };
      });

      const previousThreads = await getUnresolvedThreads({
        prisma: this.prisma,
        gitlabService: this.gitlabService,
        issueId,
        mrIid,
        gitlabProjectId,
        agentRole: AgentRole.PEN_TESTER,
      });

      const currentFingerprints = new Set(
        findingsForThreads.map(f => {
          const raw = `${f.severity}:${f.file ?? ''}:${f.message}`.toLowerCase().trim().substring(0, 60);
          return require('crypto').createHash('sha256').update(raw).digest('hex').substring(0, 16);
        }),
      );
      const resolvedThreadIds = previousThreads
        .filter(t => !currentFingerprints.has(t.fingerprint))
        .map(t => t.id);
      const resolvedThreadRecords = previousThreads.filter(t => !currentFingerprints.has(t.fingerprint));

      if (resolvedThreadIds.length > 0) {
        await resolveThreads({
          prisma: this.prisma,
          gitlabService: this.gitlabService,
          gitlabProjectId,
          mrIid,
          threadIds: resolvedThreadIds,
        });
      }

      const existingFingerprints = new Set(previousThreads.map(t => t.fingerprint));
      const newFindings = findingsForThreads.filter(f => {
        const raw = `${f.severity}:${f.file ?? ''}:${f.message}`.toLowerCase().trim().substring(0, 60);
        const fp = require('crypto').createHash('sha256').update(raw).digest('hex').substring(0, 16);
        return !existingFingerprints.has(fp);
      });

      const roundNumber = (testResult.roundNumber ?? 1);
      const newThreads = await postFindingsAsThreads({
        prisma: this.prisma,
        gitlabService: this.gitlabService,
        issueId,
        mrIid,
        gitlabProjectId,
        agentRole: AgentRole.PEN_TESTER,
        roundNumber,
        findings: newFindings,
      });

      const stillUnresolved = previousThreads.filter(t => currentFingerprints.has(t.fingerprint));
      const allActiveThreads = [...stillUnresolved, ...newThreads];

      const testMarkdown = buildIssueSummaryWithThreadLinks({
        agentName: 'Security Test',
        approved: testResult.passed,
        summary: testResult.summary,
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

    const relevantFindings = testResult.findings.filter(f => f.severity !== 'info');
    const feedback = relevantFindings
      .map((f, i) => {
        const persist = f.persistsSinceRound ? ` (open since round ${f.persistsSinceRound})` : '';
        const parts = [`${i + 1}. [${f.severity.toUpperCase()}] [${f.category}]${persist}`];
        parts.push(`   Vulnerability: ${f.description}`);
        if (f.file) parts.push(`   File: ${f.file}${f.line ? `:${f.line}` : ''}`);
        if (f.expectedFix) {
          parts.push(`   EXPECTED FIX: ${f.expectedFix}`);
        } else {
          parts.push(`   Fix: ${f.recommendation}`);
        }
        if (f.exploitScenario) parts.push(`   Exploit: ${f.exploitScenario}`);
        return parts.join('\n');
      })
      .join('\n\n');

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

      // Extract roundNumber and resolvedFromPrevious from LLM output
      const roundNumber = typeof parsed.roundNumber === 'number' ? parsed.roundNumber : undefined;
      const resolvedFromPrevious = Array.isArray(parsed.resolvedFromPrevious)
        ? parsed.resolvedFromPrevious
            .filter((r: any) => r && typeof r === 'object')
            .map((r: any) => ({
              category: String(r.category ?? 'Unknown'),
              description: String(r.description ?? ''),
              resolvedBy: String(r.resolvedBy ?? ''),
            }))
        : undefined;

      return {
        issueId,
        passed,
        findings,
        summary,
        auditResult: parsed.auditResult || auditResult,
        roundNumber,
        resolvedFromPrevious,
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
        expectedFix: f.expectedFix ? String(f.expectedFix) : undefined,
        exploitScenario: f.exploitScenario ? String(f.exploitScenario) : undefined,
        verificationMethod: f.verificationMethod ? String(f.verificationMethod) : undefined,
        persistsSinceRound: typeof f.persistsSinceRound === 'number' ? f.persistsSinceRound : undefined,
        status: ['new', 'resolved', 'unresolved', 'blocked'].includes(f.status) ? f.status : undefined,
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

  private applyArchitectScopeFilter(
    testResult: PenTestResult,
    outOfScopeItems: string[],
    maxWarnings: number,
  ): PenTestResult {
    if (outOfScopeItems.length === 0 || testResult.findings.length === 0) {
      return testResult;
    }

    const { filtered, removedCount } = filterOutOfScopeFindings(
      testResult.findings,
      outOfScopeItems,
      (f) => `${f.category} ${f.description} ${f.recommendation} ${f.file ?? ''}`,
    );

    if (removedCount === 0) return testResult;

    const criticalCount = filtered.filter((f) => f.severity === 'critical').length;
    const warningCount = filtered.filter((f) => f.severity === 'warning').length;
    const passed = criticalCount === 0 && warningCount <= maxWarnings;

    this.logger.log(
      `Architect scope filter removed ${removedCount} security finding(s) as out-of-scope`,
    );

    const summarySuffix = `Architect scope filter ignored ${removedCount} out-of-scope finding(s).`;
    const summary = testResult.summary
      ? `${testResult.summary} ${summarySuffix}`
      : summarySuffix;

    return {
      ...testResult,
      passed,
      findings: filtered,
      summary,
    };
  }

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
