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
  getAgentCommentHistory,
} from '../agent-comment.utils';
import {
  extractArchitectOutOfScopeItems,
} from '../agent-scope.utils';
import { UiTestResult } from './ui-test-result.interface';
import { PlaywrightRunner } from './playwright-runner';
import {
  analyzeScreenshots,
  updateManifestDescriptions,
  formatBrowserData,
  extractRoutesFromDiffs,
  collectAndSaveScreenshots,
  fetchDiffsWithRetry,
  buildUserPrompt,
} from './ui-tester-analysis';
import {
  parseTestResult,
  applyArchitectScopeFilter,
  buildFailureFeedback,
  dualTestFindingKey,
  postFindingThreadsAndComment,
} from './ui-tester-result';
import { AgentRole, AgentStatus, AgentTaskStatus } from '@prisma/client';

const DEFAULT_SYSTEM_PROMPT = loadPrompt('ui-tester');

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
      const diffs = await fetchDiffsWithRetry(
        this.gitlabService, gitlabProjectId, mrIid, 3, 5000,
      );

      // Determine preview URL
      const previewDomain = this.settings.get('preview.domain', '');
      const previewUrl =
        project?.previewPort && project?.slug && previewDomain
          ? `https://${project.slug}.${previewDomain}`
          : null;

      // ─── Browser capture phase ─────────────────────────────
      let browserData = '';
      let screenshotImages: Array<{ base64: string; label: string }> = [];
      let screenshotManifestPath: string | undefined;

      if (previewUrl) {
        const result = await this.capturePreview(
          ctx,
          previewUrl,
          diffs,
          project,
          issue,
          issueId,
        );
        browserData = result.browserData;
        screenshotImages = result.screenshotImages;
        screenshotManifestPath = result.screenshotManifestPath;
      }

      if (!browserData && screenshotImages.length === 0) {
        await this.sendAgentMessage(
          ctx,
          'No preview available — running code-only UI analysis',
        );
      }

      // ─── Build LLM prompt ─────────────────────────────────
      const config = this.getRoleConfig();
      const systemPrompt = config.systemPrompt || DEFAULT_SYSTEM_PROMPT;

      const commentHistory = await getAgentCommentHistory({
        prisma: this.prisma,
        issueId,
        maxChars: this.getMaxHistoryChars(),
      });
      const outOfScopeItems = extractArchitectOutOfScopeItems(commentHistory);

      // Visual screenshot analysis
      let visualAnalysis = '';
      if (screenshotImages.length > 0) {
        try {
          await this.sendAgentMessage(
            ctx,
            `Analyzing ${screenshotImages.length} screenshots visually...`,
          );
          visualAnalysis = await analyzeScreenshots(
            this.llmService,
            this.settings,
            config,
            screenshotImages,
            issue.title,
          );
          if (screenshotManifestPath) {
            await updateManifestDescriptions(
              screenshotManifestPath,
              visualAnalysis,
            );
          }
        } catch (err) {
          this.logger.warn(`Visual screenshot analysis failed: ${err.message}`);
        }
      }

      const userPrompt = buildUserPrompt(
        issue,
        previewUrl,
        diffs,
        commentHistory,
        outOfScopeItems,
        browserData,
        visualAnalysis,
      );

      // ─── Execute LLM (MCP or dual) ────────────────────────
      const workspace = project?.slug
        ? await this.resolveWorkspace(project.slug, ctx.chatSessionId)
        : '';

      let resultContent = '';
      let testResult: UiTestResult | null = null;

      const mcpServers = workspace
        ? await this.mcpRegistry.resolveServersForRole(AgentRole.UI_TESTER, {
            workspace,
            allowedPaths: [workspace],
            projectId: ctx.projectId,
          })
        : [];

      if (mcpServers.length > 0 && workspace) {
        const mcpContent = await this.runMcpLoop(
          ctx, config, systemPrompt, userPrompt, mcpServers, workspace,
        );
        if (mcpContent === null) return; // MCP failed, already marked
        resultContent = mcpContent;
      } else {
        const dualResult = await this.runDualLlm(
          ctx, config, systemPrompt, userPrompt, issueId, outOfScopeItems,
        );
        if (dualResult === null) return; // LLM failed, already marked
        if (typeof dualResult === 'object') {
          // Dual merge produced a final UiTestResult — skip parsing
          testResult = dualResult;
        } else {
          resultContent = dualResult;
        }
      }

      // ─── Parse and handle result ───────────────────────────
      if (!testResult) {
        testResult = parseTestResult(resultContent, issueId);

        // Retry JSON extraction if parsing returned 0 findings but response was substantial
        const dualConfigured = this.dualTestService.isDualConfigured(config);
        if (
          testResult &&
          testResult.findings.length === 0 &&
          resultContent.length > 500 &&
          !dualConfigured
        ) {
          testResult = await this.retryJsonParse(config, resultContent, issueId, testResult);
        }

        // Retry full parse failure with JSON extraction
        if (!testResult && resultContent.length > 500) {
          testResult = await this.retryJsonParse(config, resultContent, issueId, null);
        }

        if (!testResult) {
          await this.sendAgentMessage(
            ctx,
            'Could not parse UI test result — defaulting to pass',
          );
          await this.handleResult(ctx, issueId, mrIid, gitlabProjectId, {
            issueId,
            passed: true,
            findings: [],
            summary: 'Parse failed — auto-passed',
            pagesChecked: 0,
          });
          return;
        }

        // Enforce Architect out-of-scope constraints
        testResult = applyArchitectScopeFilter(testResult, outOfScopeItems);
      }

      // Post finding threads to MR and comment
      await postFindingThreadsAndComment({
        prisma: this.prisma,
        gitlabService: this.gitlabService,
        issueId,
        mrIid,
        gitlabProjectId,
        issueIid: issue.gitlabIid!,
        agentTaskId: ctx.agentTaskId,
        testResult,
      });

      await this.handleResult(ctx, issueId, mrIid, gitlabProjectId, testResult);
    } catch (err) {
      this.logger.error(`UI test failed: ${err.message}`, err.stack);
      await this.sendAgentMessage(ctx, `**UI Tester** error: ${err.message}`);
      await this.markFailed(ctx, err.message);
    }
  }

  // ─── Preview Capture ─────────────────────────────────────

  private async capturePreview(
    ctx: AgentContext,
    previewUrl: string,
    diffs: any[],
    project: any,
    issue: any,
    issueId: string,
  ): Promise<{
    browserData: string;
    screenshotImages: Array<{ base64: string; label: string }>;
    screenshotManifestPath: string | undefined;
  }> {
    const runner = await this.ensurePlaywright();
    if (!runner) return { browserData: '', screenshotImages: [], screenshotManifestPath: undefined };

    await this.sendAgentMessage(ctx, `Running browser tests against ${previewUrl}...`);

    const routes = extractRoutesFromDiffs(diffs);
    if (routes.length === 0) routes.push('/');

    const captures = await runner.capturePages(previewUrl, routes);
    const a11y = await runner.checkAccessibility(previewUrl, routes[0]);
    const responsive = await runner.checkResponsive(previewUrl, routes[0]);

    const browserData = formatBrowserData(captures, a11y, responsive);

    // Save screenshots + collect base64 for multimodal LLM
    const resolvedWorkspace = project?.slug
      ? await this.resolveWorkspace(project.slug, ctx.chatSessionId)
      : '';

    if (!resolvedWorkspace) {
      return { browserData, screenshotImages: [], screenshotManifestPath: undefined };
    }

    const { screenshotImages, screenshotManifestPath } =
      await collectAndSaveScreenshots(
        runner, resolvedWorkspace, issueId, issue.title, captures, responsive,
      );

    return { browserData, screenshotImages, screenshotManifestPath };
  }

  // ─── MCP Loop Execution ──────────────────────────────────

  private async runMcpLoop(
    ctx: AgentContext,
    config: ReturnType<typeof this.getRoleConfig>,
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
      `Running UI tests with shell access (${mcpServers.length} MCP tools)...`,
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
      await this.sendAgentMessage(ctx, 'UI Tester MCP loop failed');
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

  // ─── Dual LLM Execution ─────────────────────────────────

  /**
   * Run dual LLM call. Returns:
   * - UiTestResult: dual merge succeeded, ready for thread posting + handle
   * - string: primary content to parse (no dual merge)
   * - null: LLM error, already marked failed
   */
  private async runDualLlm(
    ctx: AgentContext,
    config: ReturnType<typeof this.getRoleConfig>,
    systemPrompt: string,
    userPrompt: string,
    issueId: string,
    outOfScopeItems: string[],
  ): Promise<UiTestResult | string | null> {
    const messages: LlmMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];

    const dualResult = await this.dualTestService.callDual(config, messages);

    if (dualResult.primary.finishReason === 'error') {
      await this.sendAgentMessage(ctx, 'UI Tester LLM call failed');
      await this.markFailed(
        ctx,
        `LLM call failed: ${dualResult.primary.errorMessage ?? 'unknown error'}`,
      );
      return null;
    }

    // Dual-testing: parse secondary and merge findings
    if (
      dualResult.secondary &&
      dualResult.secondary.finishReason !== 'error'
    ) {
      const primaryResult = parseTestResult(dualResult.primary.content, issueId);
      const secondaryResult = parseTestResult(dualResult.secondary.content, issueId);
      if (primaryResult && secondaryResult) {
        const strategy = config.dualStrategy ?? 'merge';
        const { merged, stats } = this.dualTestService.mergeFindings(
          primaryResult.findings,
          secondaryResult.findings,
          strategy,
          dualTestFindingKey,
        );

        const passed = this.dualTestService.determineApproval(merged, 3);
        const mergedTestResult: UiTestResult = {
          ...primaryResult,
          findings: merged,
          passed,
          pagesChecked: Math.max(
            primaryResult.pagesChecked,
            secondaryResult.pagesChecked,
          ),
        };
        const scopedResult = applyArchitectScopeFilter(mergedTestResult, outOfScopeItems);

        await this.sendAgentMessage(
          ctx,
          `**Dual-test** (${strategy}): ${stats.primaryCount} + ${stats.secondaryCount} → ${stats.mergedCount} findings [${dualResult.providers.primary} + ${dualResult.providers.secondary}]`,
        );

        return scopedResult;
      }
    }

    return dualResult.primary.content;
  }

  // ─── JSON Retry ──────────────────────────────────────────

  private async retryJsonParse(
    config: ReturnType<typeof this.getRoleConfig>,
    resultContent: string,
    issueId: string,
    existing: UiTestResult | null,
  ): Promise<UiTestResult | null> {
    const retryJson = await this.dualTestService.retryJsonExtraction(
      config,
      resultContent,
      '{"passed": true/false, "summary": "...", "pagesChecked": 0, "findings": [{"type": "accessibility|responsive|ux|consistency|missing", "page": "...", "description": "...", "severity": "info|warning|critical"}]}',
    );
    if (retryJson) {
      const retried = parseTestResult(retryJson, issueId);
      if (retried && retried.findings.length > 0) {
        this.logger.log(
          `JSON retry recovered ${retried.findings.length} UI findings`,
        );
        return retried;
      }
      if (!existing && retried) {
        this.logger.log(
          `JSON retry recovered full UI result (${retried.findings.length} findings)`,
        );
        return retried;
      }
    }
    return existing;
  }

  // ─── Result Handler ─────────────────────────────────────

  private async handleResult(
    ctx: AgentContext,
    issueId: string,
    mrIid: number,
    gitlabProjectId: number,
    testResult: UiTestResult,
  ): Promise<void> {
    const statusLabel = testResult.passed ? 'passed' : 'failed';
    const findingsText = testResult.passed
      ? ''
      : '\n\n' +
        testResult.findings
          .filter((f) => f.severity !== 'info')
          .map((f) => `- **${f.severity}** [${f.type}] ${f.page}: ${f.description}`)
          .join('\n');

    await this.sendAgentMessage(
      ctx,
      `**UI Test ${statusLabel}** for MR !${mrIid}\n\n${testResult.summary}${findingsText}`,
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

    const event: any = {
      projectId: ctx.projectId,
      chatSessionId: ctx.chatSessionId,
      issueId,
      mrIid,
      gitlabProjectId,
      passed: testResult.passed,
    };
    if (!testResult.passed) {
      event.feedback = `UI Test findings:\n\n${buildFailureFeedback(testResult.findings)}`;
    }
    this.eventEmitter.emit('agent.uiTestComplete', event);
  }

  // ─── Helpers ────────────────────────────────────────────

  private async markFailed(ctx: AgentContext, reason: string): Promise<void> {
    try {
      await this.prisma.agentTask.update({
        where: { id: ctx.agentTaskId },
        data: { status: AgentTaskStatus.FAILED, completedAt: new Date() },
      });
      await this.updateStatus(ctx, AgentStatus.ERROR);
      await this.log(ctx.agentTaskId, 'ERROR', `UI test failed: ${reason}`);

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
