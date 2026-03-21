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
} from '../agent-scope.utils';
import {
  syncFindingThreads,
  buildIssueSummaryWithThreadLinks,
  FindingForThread,
} from '../finding-thread.utils';
import {
  FunctionalTestResult,
  FunctionalTestFinding,
} from './functional-test-result.interface';
import {
  parseTestResult,
  applyArchitectScopeFilter,
  matchFindingToSubIssue,
} from './functional-tester-result';
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

      // Format diffs
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

      // Inject project knowledge base (Wiki-First)
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

      const loopResolverSection =
        extractLoopResolverClarifications(commentHistory);

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

      // Try MCP agent loop (with shell access) if workspace exists
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
        // Fallback: plain LLM call
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
      let testResult = parseTestResult(resultContent, issueId);

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
          const retried = parseTestResult(retryJson, issueId);
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
          testResult = parseTestResult(retryJson, issueId);
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

      // Enforce Architect out-of-scope constraints
      testResult = applyArchitectScopeFilter(testResult, outOfScopeItems);

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

      // Post unified comment
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
   * and update each sub-issue's status.
   */
  private async updateSubIssueStatuses(
    subIssues: { id: string; title: string }[],
    findings: FunctionalTestFinding[],
  ): Promise<void> {
    for (const sub of subIssues) {
      const match = matchFindingToSubIssue(sub.title, findings);
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

  // ─── Diff Fetching ──────────────────────────────────────

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
        data: { status: AgentTaskStatus.FAILED, completedAt: new Date() },
      });
      await this.updateStatus(ctx, AgentStatus.ERROR);
      await this.log(
        ctx.agentTaskId,
        'ERROR',
        `Functional test failed: ${reason}`,
      );

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
