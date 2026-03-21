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
  syncFindingThreads,
  buildIssueSummaryWithThreadLinks,
} from '../finding-thread.utils';
import {
  buildArchitectScopeGuardSection,
  extractArchitectOutOfScopeItems,
} from '../agent-scope.utils';
import { PenTestResult, SecurityFinding } from './pen-test-result.interface';
import { AgentRole, AgentStatus, AgentTaskStatus } from '@prisma/client';

// Extracted modules
import {
  runNpmAudit,
  checkSecurityHeaders,
  buildTechStackContext,
  fetchDiffsWithRetry,
} from './pen-tester-audit';
import {
  parseTestResult,
  applyArchitectScopeFilter,
  applyCriticalOverride,
  buildFindingsForThreads,
  buildFailureFeedback,
} from './pen-tester-result';
import {
  buildPenTesterUserPrompt,
  buildPreviousFindingsSection,
} from './pen-tester-prompt';

const DEFAULT_SYSTEM_PROMPT = loadPrompt('pen-tester');

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
    super(
      prisma,
      settings,
      chatService,
      chatGateway,
      llmService,
      monitorGateway,
    );
  }

  /** Get the max warnings threshold from pipeline config / per-agent setting / fallback */
  private getMaxWarnings(): number {
    const val = this.settings.get('pentester.maxWarnings', '', '');
    if (val) {
      const num = parseInt(val, 10);
      if (!isNaN(num)) return num;
    }
    return this.getMaxWarningsForApproval();
  }

  /** Check if header checks should be skipped (configurable per-project via settings) */
  private shouldSkipHeaderCheck(): boolean {
    return (
      this.settings.get('pentester.skipHeaderCheck', '', 'false') === 'true'
    );
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
        const workspace = await this.resolveWorkspace(
          project.slug,
          ctx.chatSessionId,
        );
        const audit = await runNpmAudit(
          workspace,
          this.getAuditTimeoutMs(),
          this.logger,
        );
        auditReport = audit.report;
        auditResult = audit.summary;
      }

      // ─── Phase 2: HTTP Header Check (skippable) ──────
      let headerReport = '';
      if (!this.shouldSkipHeaderCheck()) {
        const previewDomain = this.settings.get('preview.domain', '');
        const previewUrl =
          project?.previewPort && project?.slug && previewDomain
            ? `https://${project.slug}.${previewDomain}`
            : null;

        if (previewUrl) {
          headerReport = await checkSecurityHeaders(previewUrl, this.logger);
        }
      }

      // ─── Phase 3: MR Diffs ──────────────────
      const diffs = await fetchDiffsWithRetry(
        this.gitlabService,
        gitlabProjectId,
        mrIid,
        3,
        5000,
        this.logger,
      );

      const MAX_DIFFS = 15;
      const MAX_DIFF_CHARS = this.getMaxDiffChars();
      const reviewDiffs = diffs.slice(0, MAX_DIFFS);

      const diffText = reviewDiffs
        .map((d) => {
          const prefix = d.new_file
            ? '[NEW]'
            : d.deleted_file
              ? '[DELETED]'
              : '[MODIFIED]';
          const truncated =
            d.diff.length > MAX_DIFF_CHARS
              ? d.diff.substring(0, MAX_DIFF_CHARS) + '\n... (truncated)'
              : d.diff;
          return `### ${prefix} ${d.new_path}\n\`\`\`diff\n${truncated}\n\`\`\``;
        })
        .join('\n\n');

      // ─── Phase 4: Build LLM prompt ──────────────
      const { userPrompt, systemPrompt, maxWarnings, outOfScopeItems } =
        await this.buildPromptContext(
          issue,
          project,
          issueId,
          diffs,
          reviewDiffs,
          diffText,
          auditReport,
          headerReport,
        );

      // ─── Phase 5: Execute LLM / MCP ──────────────
      const config = this.getRoleConfig();
      const workspace = project?.slug
        ? await this.resolveWorkspace(project.slug, ctx.chatSessionId)
        : '';

      let resultContent: string;

      const mcpServers = workspace
        ? await this.mcpRegistry.resolveServersForRole(AgentRole.PEN_TESTER, {
            workspace,
            allowedPaths: [workspace],
            projectId: ctx.projectId,
          })
        : [];

      if (mcpServers.length > 0 && workspace) {
        const mcpResult = await this.runMcpPath(
          ctx,
          config,
          systemPrompt,
          userPrompt,
          mcpServers,
          workspace,
        );
        if (!mcpResult) return; // already marked failed
        resultContent = mcpResult;
      } else {
        const dualResult = await this.runDualLlmPath(
          ctx,
          config,
          systemPrompt,
          userPrompt,
          issueId,
          mrIid,
          gitlabProjectId,
          issue,
          auditResult,
          outOfScopeItems,
          maxWarnings,
        );
        if (dualResult === null) return; // already handled
        if (dualResult === undefined) {
          // dual path returned early after handling pass/fail itself
          return;
        }
        resultContent = dualResult;
      }

      // ─── Phase 6: Parse & evaluate result ──────
      await this.evaluateAndFinish(
        ctx,
        resultContent,
        issueId,
        mrIid,
        gitlabProjectId,
        issue,
        auditResult,
        outOfScopeItems,
        maxWarnings,
        config,
      );
    } catch (err) {
      this.logger.error(`Security test failed: ${err.message}`, err.stack);
      await this.sendAgentMessage(ctx, `**Pen Tester** error: ${err.message}`);
      await this.markFailed(ctx, err.message);
    }
  }

  // ─── Prompt Building ──────────────────────────────────

  private async buildPromptContext(
    issue: any,
    project: any,
    issueId: string,
    diffs: any[],
    reviewDiffs: any[],
    diffText: string,
    auditReport: string,
    headerReport: string,
  ) {
    const config = this.getRoleConfig();
    const systemPrompt = config.systemPrompt || DEFAULT_SYSTEM_PROMPT;

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

    const maxWarnings = this.getMaxWarnings();
    const previousFindings = extractLastAgentFindings(
      commentHistory,
      'Pen Tester',
    );

    const userPrompt = buildPenTesterUserPrompt({
      issueTitle: issue.title,
      issueDescription: issue.description,
      techStackContext: buildTechStackContext(project),
      maxWarnings,
      loopResolverSection: extractLoopResolverClarifications(commentHistory),
      previousFindingsSection: buildPreviousFindingsSection(previousFindings),
      historySection,
      scopeGuardSection,
      reviewDiffCount: reviewDiffs.length,
      totalDiffCount: diffs.length,
      diffText,
      auditReport,
      headerReport,
      hasPreviousFindings: previousFindings.length > 0,
    });

    return { userPrompt, systemPrompt, maxWarnings, outOfScopeItems };
  }

  // ─── MCP Execution Path ───────────────────────────────

  private async runMcpPath(
    ctx: AgentContext,
    config: any,
    systemPrompt: string,
    userPrompt: string,
    mcpServers: any[],
    workspace: string,
  ): Promise<string | null> {
    this.logger.log(
      `Using MCP agent loop with ${mcpServers.length} servers (workspace: ${workspace})`,
    );
    await this.sendAgentMessage(
      ctx,
      `Running security analysis with shell access (${mcpServers.length} MCP tools — semgrep, trivy, etc.)...`,
    );

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
      await this.markFailed(
        ctx,
        `MCP agent loop failed: ${mcpResult.errorMessage ?? 'unknown error'}`,
      );
      return null;
    }

    this.logger.log(
      `MCP loop: ${mcpResult.iterations} iterations, ${mcpResult.toolCallsExecuted} tool calls`,
    );
    return mcpResult.content;
  }

  // ─── Dual LLM Execution Path ──────────────────────────

  /**
   * Run dual-LLM call. Returns:
   * - string: primary content for further parsing
   * - undefined: dual path handled pass/fail itself (caller should return)
   * - null: LLM call failed (caller should return)
   */
  private async runDualLlmPath(
    ctx: AgentContext,
    config: any,
    systemPrompt: string,
    userPrompt: string,
    issueId: string,
    mrIid: number,
    gitlabProjectId: number,
    issue: any,
    auditResult: PenTestResult['auditResult'] | undefined,
    outOfScopeItems: string[],
    maxWarnings: number,
  ): Promise<string | undefined | null> {
    const messages: LlmMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];

    const dualResult = await this.dualTestService.callDual(config, messages);

    if (dualResult.primary.finishReason === 'error') {
      await this.sendAgentMessage(ctx, 'Pen Tester LLM call failed');
      await this.markFailed(
        ctx,
        `LLM call failed: ${dualResult.primary.errorMessage ?? 'unknown error'}`,
      );
      return null;
    }

    // Dual-testing: parse secondary and merge/consensus findings
    if (
      dualResult.secondary &&
      dualResult.secondary.finishReason !== 'error'
    ) {
      const primaryResult = parseTestResult(
        dualResult.primary.content,
        issueId,
        auditResult,
        maxWarnings,
        this.logger,
      );
      const secondaryResult = parseTestResult(
        dualResult.secondary.content,
        issueId,
        auditResult,
        maxWarnings,
        this.logger,
      );
      if (primaryResult && secondaryResult) {
        const strategy = config.dualStrategy ?? 'merge';
        const { merged, stats } = this.dualTestService.mergeFindings(
          primaryResult.findings,
          secondaryResult.findings,
          strategy,
          (f: SecurityFinding) =>
            `${f.category}:${f.file ?? ''}:${f.severity}:${f.description.substring(0, 40).toLowerCase()}`,
        );

        const passed = this.dualTestService.determineApproval(
          merged,
          maxWarnings,
        );
        let mergedTestResult: PenTestResult = {
          ...primaryResult,
          findings: merged,
          passed,
        };
        mergedTestResult = applyArchitectScopeFilter(
          mergedTestResult,
          outOfScopeItems,
          maxWarnings,
          this.logger,
        );

        await this.sendAgentMessage(
          ctx,
          `🔀 **Dual-test** (${strategy}): ${stats.primaryCount} + ${stats.secondaryCount} → ${stats.mergedCount} findings [${dualResult.providers.primary} + ${dualResult.providers.secondary}]`,
        );

        // Rule-based override: critical findings → always fail
        applyCriticalOverride(mergedTestResult, this.logger);

        // Post finding threads + comment and handle result
        await this.finishResult(
          ctx, issueId, mrIid, gitlabProjectId, issue, mergedTestResult,
        );
        return undefined; // signal: dual path handled everything
      }
    }

    return dualResult.primary.content;
  }

  // ─── Result Evaluation ────────────────────────────────

  private async evaluateAndFinish(
    ctx: AgentContext,
    resultContent: string,
    issueId: string,
    mrIid: number,
    gitlabProjectId: number,
    issue: any,
    auditResult: PenTestResult['auditResult'] | undefined,
    outOfScopeItems: string[],
    maxWarnings: number,
    config: any,
  ): Promise<void> {
    let testResult = parseTestResult(
      resultContent, issueId, auditResult, maxWarnings, this.logger,
    );

    // Retry JSON extraction when parsing returned empty or failed
    const jsonTemplate =
      '{"passed": true/false, "summary": "1-2 sentences", "findings": [{"category": "A01:2021", "severity": "critical|warning|info", "description": "...", "file": "path", "recommendation": "fix"}], "auditResult": {"vulnerabilities": 0, "critical": 0, "high": 0}}';
    const shouldRetry =
      resultContent.length > 500 &&
      !this.dualTestService.isDualConfigured(config);

    if (shouldRetry && (!testResult || testResult.findings.length === 0)) {
      const retryJson = await this.dualTestService.retryJsonExtraction(
        config, resultContent, jsonTemplate,
      );
      if (retryJson) {
        const retried = parseTestResult(
          retryJson, issueId, auditResult, maxWarnings, this.logger,
        );
        if (retried && (!testResult || retried.findings.length > 0)) {
          this.logger.log(
            `JSON retry recovered ${retried.findings.length} security findings`,
          );
          testResult = retried;
        }
      }
    }

    if (!testResult) {
      await this.sendAgentMessage(
        ctx, 'Could not parse security test result — defaulting to pass',
      );
      await this.finishResult(ctx, issueId, mrIid, gitlabProjectId, issue, {
        issueId, passed: true, findings: [], summary: 'Parse failed — auto-passed',
      });
      return;
    }

    // Apply scope filter + critical override
    testResult = applyArchitectScopeFilter(
      testResult, outOfScopeItems, maxWarnings, this.logger,
    );
    applyCriticalOverride(testResult, this.logger);

    await this.finishResult(ctx, issueId, mrIid, gitlabProjectId, issue, testResult);
  }

  // ─── Finding Threads + Pass/Fail ──────────────────────

  private async finishResult(
    ctx: AgentContext,
    issueId: string,
    mrIid: number,
    gitlabProjectId: number,
    issue: any,
    testResult: PenTestResult,
  ): Promise<void> {
    // Sync finding threads to GitLab MR
    const findingsForThreads = buildFindingsForThreads(testResult.findings);
    const { activeThreads, resolvedThreads } = await syncFindingThreads({
      prisma: this.prisma,
      gitlabService: this.gitlabService,
      issueId, mrIid, gitlabProjectId,
      agentRole: AgentRole.PEN_TESTER,
      roundNumber: testResult.roundNumber ?? 1,
      findings: findingsForThreads,
      confirmedResolved: testResult.resolvedFromPrevious?.map((r: any) => ({
        message: r.description,
      })),
    });

    // Post summary comment on the issue
    const testMarkdown = buildIssueSummaryWithThreadLinks({
      agentName: 'Security Test',
      approved: testResult.passed,
      summary: testResult.summary,
      threads: activeThreads,
      resolvedThreads,
    });
    await postAgentComment({
      prisma: this.prisma,
      gitlabService: this.gitlabService,
      issueId, gitlabProjectId,
      issueIid: issue.gitlabIid!,
      agentTaskId: ctx.agentTaskId,
      authorName: 'Pen Tester',
      markdownContent: testMarkdown,
    });

    // Build chat message
    const passed = testResult.passed;
    const statusWord = passed ? 'passed' : 'failed';
    const findingsText = passed
      ? ''
      : '\n\n' +
        testResult.findings
          .filter((f) => f.severity !== 'info')
          .map(
            (f) =>
              `- **${f.severity}** [${f.category}]${f.file ? ` \`${f.file}${f.line ? `:${f.line}` : ''}\`` : ''}: ${f.description}`,
          )
          .join('\n');

    await this.sendAgentMessage(
      ctx,
      `**Security Test ${statusWord}** for MR !${mrIid}\n\n${testResult.summary}${findingsText}`,
    );

    // Complete task
    await this.prisma.agentTask.update({
      where: { id: ctx.agentTaskId },
      data: {
        status: AgentTaskStatus.COMPLETED,
        output: sanitizeJsonOutput(testResult) as any,
        completedAt: new Date(),
      },
    });
    await this.updateStatus(ctx, AgentStatus.IDLE);

    // Emit event for orchestrator
    this.eventEmitter.emit('agent.penTestComplete', {
      projectId: ctx.projectId,
      chatSessionId: ctx.chatSessionId,
      issueId, mrIid, gitlabProjectId,
      passed,
      ...(passed
        ? {}
        : { feedback: `Security Test findings:\n\n${buildFailureFeedback(testResult.findings)}` }),
    });
  }

  // ─── Helpers ──────────────────────────────────────────

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
        `Security test failed: ${reason}`,
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
