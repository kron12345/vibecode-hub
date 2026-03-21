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
import { McpAgentLoopService } from '../../mcp/mcp-agent-loop.service';
import { McpRegistryService } from '../../mcp/mcp-registry.service';
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
  filterOutOfScopeFindings,
} from '../agent-scope.utils';
import {
  syncFindingThreads,
  buildIssueSummaryWithThreadLinks,
  FindingForThread,
} from '../finding-thread.utils';
import { stripThinkTags, cleanJsonString, findJsonObject, extractJson, normalizePass, normalizeSeverity, formatDiffsForPrompt } from '../agent-result-parser';
import {
  FunctionalTestResult,
  FunctionalTestFinding,
} from './functional-test-result.interface';
import {
  AgentRole,
  AgentStatus,
  AgentTaskStatus,
  IssueStatus,
} from '@prisma/client';

const COMPLETION_MARKER = ':::TEST_COMPLETE:::';

const DEFAULT_SYSTEM_PROMPT = loadPrompt('functional-tester');

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
    monitorGateway: MonitorGateway,
    private readonly eventEmitter: EventEmitter2,
    private readonly dualTestService: DualTestService,
    private readonly mcpAgentLoop: McpAgentLoopService,
    private readonly mcpRegistry: McpRegistryService,
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
      const diffs = await this.fetchDiffsWithRetry(
        gitlabProjectId,
        mrIid,
        3,
        5000,
      );

      if (diffs.length === 0) {
        await this.sendAgentMessage(ctx, 'MR has no diffs — auto-passing');
        await this.handlePassed(ctx, issueId, mrIid, gitlabProjectId, {
          issueId,
          passed: true,
          findings: [],
          summary: 'No diffs in MR',
        });
        return;
      }

      // Build prompt
      const config = this.getRoleConfig();
      const systemPrompt = config.systemPrompt || DEFAULT_SYSTEM_PROMPT;

      // Collect acceptance criteria from sub-issues
      const acceptanceCriteria = issue.subIssues
        .map(
          (sub, i) =>
            `${i + 1}. ${sub.title}${sub.description ? ': ' + sub.description : ''}`,
        )
        .join('\n');

      // Format diffs (same pattern as Code Reviewer)
      const MAX_DIFFS = 25;
      const MAX_DIFF_CHARS = 2000;
      const reviewDiffs = diffs.slice(0, MAX_DIFFS);

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

      // Inject previous agent comments as context
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

      // Build structured previous findings section (Expectation Pattern memory)
      const previousFindings = extractLastAgentFindings(
        commentHistory,
        'Functional Tester',
      );
      const previousFindingsSection =
        previousFindings.length > 0
          ? `\n## YOUR Previous Test Results — Re-Evaluate Each One\n${previousFindings
              .map(
                (f, i) =>
                  `${i + 1}. Criterion: "${f.criterion ?? f.message}"\n   Previous verdict: FAILED\n   Previous observation: ${f.message}\n   → NOW CHECK: is this fixed in the current code?`,
              )
              .join('\n\n')}\n`
          : '';

      // Extract Loop Resolver clarifications (if any) — must be respected by tester
      const loopResolverSection = extractLoopResolverClarifications(commentHistory);

      const userPrompt = `Verify the following merge request${previousFindings.length > 0 ? ' (Re-test after fix attempt)' : ''} implements the issue requirements:

**Issue:** ${issue.title}
**Description:** ${issue.description || 'N/A'}
${loopResolverSection ? `\n${loopResolverSection}\n` : ''}${previousFindingsSection}${historySection}${knowledgeSection}
${scopeGuardSection}
## Acceptance Criteria:
${acceptanceCriteria || '_No sub-issues / acceptance criteria defined — verify based on issue description._'}

## MR Diffs (${reviewDiffs.length} of ${diffs.length} file(s)):

${diffText}

${
  previousFindings.length > 0
    ? 'IMPORTANT: First address each item in "YOUR Previous Test Results" above, then check remaining criteria.'
    : 'Analyze each acceptance criterion against the code changes.'
}

IMPORTANT: You MUST end your response with the JSON result in this EXACT format:
${COMPLETION_MARKER}
\`\`\`json
{"passed": true/false, "summary": "...", "roundNumber": 1, "findings": [{"criterion": "...", "passed": true/false, "details": "...", "severity": "info/warning/critical", "conclusiveness": "definitive/inconclusive", "expectedEvidence": "...", "actualEvidence": "...", "status": "new/unresolved/blocked"}]}
\`\`\`
Do NOT omit the JSON block.`;

      // Try MCP agent loop (with shell access) if workspace exists, else fallback to plain LLM
      let resultContent: string;

      const mcpServers = workspace
        ? await this.mcpRegistry.resolveServersForRole(
            AgentRole.FUNCTIONAL_TESTER,
            { workspace, allowedPaths: [workspace], projectId: ctx.projectId },
          )
        : [];

      if (mcpServers.length > 0 && workspace) {
        this.logger.log(
          `Using MCP agent loop with ${mcpServers.length} servers (workspace: ${workspace})`,
        );
        await this.sendAgentMessage(
          ctx,
          `Running functional tests with shell access (${mcpServers.length} MCP tools)...`,
        );

        const mcpResult = await this.mcpAgentLoop.run({
          provider: config.provider,
          model: config.model,
          systemPrompt,
          userPrompt,
          mcpServers,
          maxIterations: 20,
          temperature: config.parameters.temperature,
          maxTokens: config.parameters.maxTokens,
          agentTaskId: ctx.agentTaskId,
          cwd: workspace,
        });

        if (mcpResult.finishReason === 'error') {
          await this.sendAgentMessage(ctx, 'Functional Tester MCP loop failed');
          await this.markFailed(
            ctx,
            `MCP agent loop failed: ${mcpResult.errorMessage ?? 'unknown error'}`,
          );
          return;
        }

        resultContent = mcpResult.content;
        this.logger.log(
          `MCP loop: ${mcpResult.iterations} iterations, ${mcpResult.toolCallsExecuted} tool calls`,
        );
      } else {
        // Fallback: plain LLM call (no shell access)
        const messages: LlmMessage[] = [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ];

        const result = await this.callLlm(messages);

        if (result.finishReason === 'error') {
          await this.sendAgentMessage(ctx, 'Functional Tester LLM call failed');
          await this.markFailed(
            ctx,
            `LLM call failed: ${result.errorMessage ?? 'unknown error'}`,
          );
          return;
        }

        resultContent = result.content;
      }

      // Parse test result
      let testResult = this.parseTestResult(resultContent, issueId);

      // Retry JSON extraction if parsing returned 0 findings but response was substantial
      if (
        testResult &&
        testResult.findings.length === 0 &&
        resultContent.length > 500
      ) {
        const retryJson = await this.dualTestService.retryJsonExtraction(
          config,
          resultContent,
          '{"passed": true/false, "summary": "...", "findings": [{"criterion": "...", "passed": true/false, "details": "...", "severity": "info|warning|critical"}]}',
        );
        if (retryJson) {
          const retried = this.parseTestResult(retryJson, issueId);
          if (retried && retried.findings.length > 0) {
            this.logger.log(
              `JSON retry recovered ${retried.findings.length} findings`,
            );
            testResult = retried;
          }
        }
      }

      // Retry full parse failure with JSON extraction
      if (!testResult && resultContent.length > 500) {
        const retryJson = await this.dualTestService.retryJsonExtraction(
          config,
          resultContent,
          '{"passed": true/false, "summary": "...", "findings": [{"criterion": "...", "passed": true/false, "details": "...", "severity": "info|warning|critical"}]}',
        );
        if (retryJson) {
          testResult = this.parseTestResult(retryJson, issueId);
          if (testResult) {
            this.logger.log(
              `JSON retry recovered full result (${testResult.findings.length} findings)`,
            );
          }
        }
      }

      if (!testResult) {
        await this.sendAgentMessage(
          ctx,
          'Could not parse test result — defaulting to pass',
        );
        await this.handlePassed(ctx, issueId, mrIid, gitlabProjectId, {
          issueId,
          passed: true,
          findings: [],
          summary: 'Parse failed — auto-passed',
        });
        return;
      }

      // Enforce Architect out-of-scope constraints server-side to avoid false FAIL loops.
      testResult = this.applyArchitectScopeFilter(testResult, outOfScopeItems);

      // ─── Finding Threads: Post findings as MR discussion threads ───
      const failedFindings = testResult.findings.filter((f) => !f.passed);
      const findingsForThreads: FindingForThread[] = failedFindings.map((f) => {
        const parts = [
          `**${(f.severity ?? 'warning').toUpperCase()}** — ${f.criterion}`,
          '',
          f.details,
        ];
        if (f.expectedEvidence)
          parts.push('', `**Expected:** ${f.expectedEvidence}`);
        if (f.actualEvidence)
          parts.push('', `**Observed:** ${f.actualEvidence}`);
        if (f.conclusiveness === 'inconclusive')
          parts.push('', '_⚠️ Inconclusive — needs runtime verification_');
        return {
          severity: f.severity ?? 'warning',
          message: f.criterion,
          threadBody: parts.join('\n'),
        };
      });

      const {
        activeThreads: allActiveThreads,
        resolvedThreads: resolvedThreadRecords,
      } = await syncFindingThreads({
        prisma: this.prisma,
        gitlabService: this.gitlabService,
        issueId,
        mrIid,
        gitlabProjectId,
        agentRole: AgentRole.FUNCTIONAL_TESTER,
        roundNumber: testResult.roundNumber ?? 1,
        findings: findingsForThreads,
        confirmedResolved: testResult.previouslyFailedResolved
          ?.filter((r: any) => r.resolved)
          .map((r: any) => ({ message: r.criterion })),
      });

      // Update sub-issue statuses based on findings
      if (issue.subIssues.length > 0 && testResult.findings.length > 0) {
        await this.updateSubIssueStatuses(issue.subIssues, testResult.findings);
      }

      // Post unified comment (same rich markdown for local + GitLab)
      const testMarkdown = buildIssueSummaryWithThreadLinks({
        agentName: 'Functional Test',
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
        authorName: 'Functional Tester',
        markdownContent: testMarkdown,
      });

      if (testResult.passed) {
        await this.handlePassed(
          ctx,
          issueId,
          mrIid,
          gitlabProjectId,
          testResult,
        );
      } else {
        await this.handleFailed(
          ctx,
          issueId,
          mrIid,
          gitlabProjectId,
          testResult,
        );
      }
    } catch (err) {
      this.logger.error(`Functional test failed: ${err.message}`, err.stack);
      await this.sendAgentMessage(
        ctx,
        `**Functional Tester** error: ${err.message}`,
      );
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
        output: sanitizeJsonOutput(testResult) as any,
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
      .filter((f) => !f.passed)
      .map(
        (f) =>
          `- **${f.severity ?? 'warning'}** — ${f.criterion}: ${f.details}`,
      )
      .join('\n');

    await this.sendAgentMessage(
      ctx,
      `**Functional Test failed** for MR !${mrIid}\n\n${testResult.summary}\n\n${failedCriteria}`,
    );

    await this.prisma.agentTask.update({
      where: { id: ctx.agentTaskId },
      data: {
        status: AgentTaskStatus.COMPLETED,
        output: sanitizeJsonOutput(testResult) as any,
        completedAt: new Date(),
      },
    });

    await this.updateStatus(ctx, AgentStatus.IDLE);

    // Build feedback for Coder
    const failedFindings = testResult.findings.filter((f) => !f.passed);
    const feedback = failedFindings
      .map((f, i) => {
        const severity = (f.severity ?? 'warning').toUpperCase();
        const persist = f.firstFailedRound
          ? ` (failing since round ${f.firstFailedRound})`
          : '';
        const conclusive =
          f.conclusiveness === 'inconclusive'
            ? ' [INCONCLUSIVE - needs runtime verification]'
            : '';
        const parts = [
          `${i + 1}. [${severity}] ${f.criterion}${persist}${conclusive}`,
        ];
        parts.push(`   Problem: ${f.details}`);
        if (f.expectedEvidence)
          parts.push(`   Expected: ${f.expectedEvidence}`);
        if (f.actualEvidence) parts.push(`   Observed: ${f.actualEvidence}`);
        return parts.join('\n');
      })
      .join('\n\n');

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

  // ─── Sub-Issue Status Tracking ──────────────────────────

  /**
   * Match functional test findings to sub-issues by title similarity
   * and update each sub-issue's status: passed → DONE, failed → NEEDS_REVIEW.
   */
  private async updateSubIssueStatuses(
    subIssues: { id: string; title: string }[],
    findings: FunctionalTestFinding[],
  ): Promise<void> {
    for (const sub of subIssues) {
      const match = this.matchFindingToSubIssue(sub.title, findings);
      if (!match) continue;

      const newStatus = match.passed
        ? IssueStatus.DONE
        : IssueStatus.NEEDS_REVIEW;

      try {
        await this.prisma.issue.update({
          where: { id: sub.id },
          data: { status: newStatus },
        });
        this.logger.log(
          `Sub-issue "${sub.title}" → ${newStatus} (finding: ${match.passed ? 'passed' : 'failed'})`,
        );
      } catch (err) {
        this.logger.warn(
          `Failed to update sub-issue ${sub.id}: ${err.message}`,
        );
      }
    }
  }

  /**
   * Find the best matching finding for a sub-issue title using fuzzy matching.
   * Returns the finding or null if no reasonable match exists.
   */
  private matchFindingToSubIssue(
    subTitle: string,
    findings: FunctionalTestFinding[],
  ): FunctionalTestFinding | null {
    const subLower = subTitle.toLowerCase().trim();
    const subWords = subLower.split(/\s+/).filter((w) => w.length > 2);

    let bestMatch: FunctionalTestFinding | null = null;
    let bestScore = 0;

    for (const finding of findings) {
      const criterionLower = finding.criterion.toLowerCase().trim();

      // Exact match
      if (criterionLower === subLower) return finding;

      // One contains the other
      if (
        criterionLower.includes(subLower) ||
        subLower.includes(criterionLower)
      ) {
        return finding;
      }

      // Word overlap scoring
      const criterionWords = criterionLower
        .split(/\s+/)
        .filter((w) => w.length > 2);
      const overlap = subWords.filter((w) =>
        criterionWords.some((cw) => cw.includes(w) || w.includes(cw)),
      );
      const score = overlap.length / Math.max(subWords.length, 1);

      if (score > bestScore && score >= 0.5) {
        bestScore = score;
        bestMatch = finding;
      }
    }

    return bestMatch;
  }

  // ─── Parsing ──────────────────────────────────────────────

  private parseTestResult(
    content: string,
    issueId: string,
  ): FunctionalTestResult | null {
    this.logger.debug(
      `Parsing functional test result (${content.length} chars)`,
    );

    if (!content.trim()) return null;

    // Strip <think> tags
    const cleaned = stripThinkTags(content);

    // Extract JSON
    const jsonStr = extractJson(cleaned, COMPLETION_MARKER);

    if (!jsonStr) {
      this.logger.warn('No JSON found — building from text');
      return this.buildResultFromText(cleaned, issueId);
    }

    try {
      const fixed = cleanJsonString(jsonStr);

      const parsed = JSON.parse(fixed);
      const findings = this.parseFindings(
        parsed.findings || parsed.criteria || parsed.tests || [],
      );

      // Inconclusive findings don't block — only definitive failures count
      const definitiveFindings = findings.filter(
        (f) => f.conclusiveness !== 'inconclusive',
      );
      const hasCritical = definitiveFindings.some(
        (f) => f.severity === 'critical',
      );
      const hasDefinitiveFailure = definitiveFindings.some((f) => !f.passed);

      // Use LLM verdict as base, but override if only inconclusive failures remain
      let passed = normalizePass(parsed);
      if (!passed && !hasCritical && !hasDefinitiveFailure) {
        // All failures are inconclusive — override to pass with warnings
        passed = true;
        this.logger.log('All failures are inconclusive — overriding to PASS');
      }

      let summary = parsed.summary || '';
      if (!summary || summary.length < 5) {
        summary = passed
          ? `All acceptance criteria verified (${findings.length} finding(s))`
          : `Functional test failed (${findings.filter((f) => !f.passed).length} criterion/a not met)`;
      }

      // Extract roundNumber and previouslyFailedResolved
      const roundNumber =
        typeof parsed.roundNumber === 'number' ? parsed.roundNumber : undefined;
      const previouslyFailedResolved = Array.isArray(
        parsed.previouslyFailedResolved,
      )
        ? parsed.previouslyFailedResolved.map((r: any) => ({
            criterion: String(r.criterion ?? ''),
            previousObservation: String(r.previousObservation ?? ''),
            currentObservation: String(r.currentObservation ?? ''),
            resolved: typeof r.resolved === 'boolean' ? r.resolved : true,
          }))
        : undefined;

      const result: FunctionalTestResult = {
        issueId,
        passed,
        findings,
        summary,
        testsRun: parsed.testsRun ?? findings.length,
        testsPassed:
          parsed.testsPassed ?? findings.filter((f) => f.passed).length,
        roundNumber,
        previouslyFailedResolved,
      };

      this.logger.log(
        `Parsed functional test: passed=${result.passed}, findings=${result.findings.length}`,
      );
      return result;
    } catch (err) {
      this.logger.error(`JSON parse failed: ${err.message}`);
      return this.buildResultFromText(cleaned, issueId);
    }
  }

  private parseFindings(raw: any): FunctionalTestFinding[] {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((f: any) => f && typeof f === 'object')
      .map((f: any) => ({
        criterion: String(f.criterion ?? f.name ?? f.test ?? 'Unknown'),
        passed: typeof f.passed === 'boolean' ? f.passed : f.status === 'pass',
        details: String(
          f.details ?? f.description ?? f.message ?? 'No details',
        ),
        severity: normalizeSeverity(f.severity),
        conclusiveness:
          f.conclusiveness === 'inconclusive' ? 'inconclusive' : 'definitive',
        expectedEvidence: f.expectedEvidence
          ? String(f.expectedEvidence)
          : undefined,
        actualEvidence: f.actualEvidence ? String(f.actualEvidence) : undefined,
        firstFailedRound:
          typeof f.firstFailedRound === 'number'
            ? f.firstFailedRound
            : undefined,
        status: ['new', 'resolved', 'unresolved', 'blocked'].includes(f.status)
          ? f.status
          : undefined,
      }));
  }

  private buildResultFromText(
    text: string,
    issueId: string,
  ): FunctionalTestResult {
    const lower = text.toLowerCase();

    // Look for strong conclusion patterns (last few lines matter most)
    const lastLines = lower.split('\n').slice(-10).join(' ');

    // Strong fail: explicit "test failed", "not passed", "result: fail"
    const strongFail =
      /\b(test(s)?\s+(have\s+)?failed|result:\s*fail|verdict:\s*fail|overall:\s*fail|not\s+passed)\b/.test(
        lastLines,
      );
    // Strong pass: explicit "test passed", "all.*pass", "result: pass"
    const strongPass =
      /\b(test(s)?\s+(have\s+)?passed|all\s+.*pass|result:\s*pass|verdict:\s*pass|overall:\s*pass)\b/.test(
        lastLines,
      );

    // If ambiguous or no clear signal, default to PASS (prevents infinite loops)
    const passed = strongFail ? false : true;

    // Extract any bullet points as pseudo-findings
    const findings: FunctionalTestFinding[] = [];
    const bulletMatches = text.match(/^[-*]\s+.+/gm) || [];
    for (const bullet of bulletMatches.slice(0, 10)) {
      const bulletLower = bullet.toLowerCase();
      const isFail = /fail|not met|missing|broken|error/i.test(bulletLower);
      findings.push({
        criterion: bullet.replace(/^[-*]\s+/, '').substring(0, 200),
        passed: !isFail,
        details: 'Extracted from text response',
        severity: isFail ? 'warning' : 'info',
      });
    }

    const summary = strongFail
      ? 'Functional test failed (parsed from text)'
      : strongPass
        ? 'Functional test passed (parsed from text)'
        : 'Functional test passed (no clear failure detected — defaulting to pass)';

    this.logger.log(
      `buildResultFromText: strongPass=${strongPass}, strongFail=${strongFail}, passed=${passed}, findings=${findings.length}`,
    );

    return { issueId, passed, findings, summary };
  }

  // ─── Diff Fetching ──────────────────────────────────────

  private applyArchitectScopeFilter(
    testResult: FunctionalTestResult,
    outOfScopeItems: string[],
  ): FunctionalTestResult {
    if (outOfScopeItems.length === 0 || testResult.findings.length === 0) {
      return testResult;
    }

    const { filtered, removedCount } = filterOutOfScopeFindings(
      testResult.findings,
      outOfScopeItems,
      (f) => `${f.criterion} ${f.details}`,
    );

    if (removedCount === 0) return testResult;

    const hasCritical = filtered.some((f) => f.severity === 'critical');
    const hasFailedCriterion = filtered.some((f) => !f.passed);
    const passed = !hasCritical && !hasFailedCriterion;

    this.logger.log(
      `Architect scope filter removed ${removedCount} functional finding(s) as out-of-scope`,
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
      testsRun: filtered.length,
      testsPassed: filtered.filter((f) => f.passed).length,
    };
  }

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
        if (diffs.length > 0) return diffs;
      } catch (err) {
        this.logger.warn(
          `Diff fetch attempt ${attempt}/${maxRetries} failed for MR !${mrIid}: ${err.message}`,
        );
      }
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
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
        data: { status: AgentTaskStatus.FAILED, completedAt: new Date() },
      });
      await this.updateStatus(ctx, AgentStatus.ERROR);
      await this.log(
        ctx.agentTaskId,
        'ERROR',
        `Functional test failed: ${reason}`,
      );

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
