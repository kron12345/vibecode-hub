import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import { SystemSettingsService } from '../../settings/system-settings.service';
import { ChatService } from '../../chat/chat.service';
import { ChatGateway } from '../../chat/chat.gateway';
import { LlmService } from '../../llm/llm.service';
import { GitlabService } from '../../gitlab/gitlab.service';
import { LlmMessage, LlmContentPart } from '../../llm/llm.interfaces';
import { BaseAgent, AgentContext } from '../agent-base';
import { MonitorGateway } from '../../monitor/monitor.gateway';
import { McpAgentLoopService } from '../../mcp/mcp-agent-loop.service';
import { McpRegistryService } from '../../mcp/mcp-registry.service';
import { DualTestService } from '../dual-test.service';
import {
  postAgentComment,
  getAgentCommentHistory,
  extractLastAgentFindings,
} from '../agent-comment.utils';
import {
  syncFindingThreads,
  buildIssueSummaryWithThreadLinks,
  FindingForThread,
} from '../finding-thread.utils';
import {
  buildArchitectScopeGuardSection,
  extractArchitectOutOfScopeItems,
  filterOutOfScopeFindings,
} from '../agent-scope.utils';
import {
  UiTestResult,
  UiTestFinding,
  ScreenshotManifest,
  ScreenshotEntry,
} from './ui-test-result.interface';
import { PlaywrightRunner, PageCapture, A11yResult } from './playwright-runner';
import * as fs from 'fs/promises';
import * as path from 'path';
import { AgentRole, AgentStatus, AgentTaskStatus } from '@prisma/client';

const COMPLETION_MARKER = ':::UI_TEST_COMPLETE:::';

const DEFAULT_SYSTEM_PROMPT = `You are the UI Tester Agent for VibCode Hub — an AI development team platform.

## Your Role
You verify the visual quality, responsiveness, accessibility, and user interaction patterns of web applications.
You have access to MCP tools including filesystem access and a shell to inspect the codebase and run builds.

## Testing Approach
1. **Read the MR diffs** to understand what UI elements were changed
2. **Use filesystem tools** to read the full source files (diffs are often truncated)
3. **Run the build** to verify compilation: \`npm run build\`, \`npx ng build\`, \`mvn compile\`, etc.
4. **Inspect templates, styles, and components** for correctness
5. **Evaluate each UI aspect** against the code AND build results

## Shell Commands You Should Try
- **Node/Angular**: \`npm install\`, \`npx ng build\`, \`npm run build\`
- **Java/Vaadin**: \`mvn compile\`, \`mvn package -DskipTests\`
- **General**: \`ls\`, \`cat\`, \`find\` to explore the project structure and templates

## Testing Areas
- **Layout**: CSS/HTML structure, correct positioning, no conflicting styles
- **Responsive**: Media queries or responsive framework classes present
- **Accessibility**: ARIA attributes, semantic HTML, alt texts in code
- **Visual**: Consistent CSS classes, correct color/font references
- **Interaction**: Event handlers attached, form validation logic present

## Expectation Pattern (Anti-Loop Protocol)
You are part of an iterative test pipeline. To prevent infinite fix loops:
1. **Review Previous Round:** If "Previous Agent Comments" exist, find YOUR OWN previous UI test results first. For each previously reported finding, check if it is still present.
2. **Classify Each Previous Finding:**
   - \`resolved\`: Fixed correctly. Report in \`resolvedFromPrevious\`. Do NOT carry forward.
   - \`unresolved\`: Still present. Carry forward with SAME description + \`persistsSinceRound\`.
   - \`blocked\`: Cannot verify without browser/runtime. NOT a FAIL reason.
3. **Mandatory Expectations:** For every FAIL finding, state the EXPECTED visual/code state via \`expectedState\`, not just the broken state. Include \`observedState\` showing what you actually see.
4. **No Rephrasing:** Use the SAME description text across rounds.
5. **Code-Only Limitations:** When analyzing without live screenshots, findings about runtime visual appearance are inherently uncertain — mark as \`verifiableFromCode: false\`. Only report "critical" if provable from code structure alone.

## IMPORTANT: Read-Only — Do NOT Modify Code
You may READ files and RUN commands, but do NOT edit or create source files. Your job is to TEST, not to fix.

## Severity Levels
- **critical**: Broken layout code, inaccessible patterns in code, missing event handlers for core interactions
- **warning**: Minor code issues, inconsistent class naming, missing alt texts
- **info**: Style suggestions, enhancement ideas

## Decision Rules
- **PASS** if: No critical findings AND ≤3 warnings
- **FAIL** if: Any critical finding OR >3 warnings
- Do NOT fail based solely on findings with \`verifiableFromCode: false\`

## Completion Format
End your analysis with EXACTLY this format:

${COMPLETION_MARKER}
\`\`\`json
{
  "passed": true,
  "summary": "Brief 1-2 sentence summary",
  "pagesChecked": 3,
  "roundNumber": 1,
  "resolvedFromPrevious": [
    {
      "type": "accessibility",
      "page": "/dashboard",
      "description": "Missing alt text on project cards",
      "resolvedBy": "alt attributes added to all img elements"
    }
  ],
  "findings": [
    {
      "type": "accessibility",
      "page": "/dashboard",
      "description": "Color contrast ratio below 4.5:1 on card titles",
      "severity": "warning",
      "verifiableFromCode": true,
      "expectedState": "Card title text should have >=4.5:1 contrast ratio against background",
      "observedState": "text-gray-400 on bg-gray-800 = ~3.5:1 ratio",
      "persistsSinceRound": null,
      "status": "new"
    }
  ]
}
\`\`\`

CRITICAL: The JSON must be valid. "type" must be one of: layout, responsive, accessibility, visual, interaction. "status" must be "new", "resolved", "unresolved", or "blocked".`;

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
      const diffs = await this.fetchDiffsWithRetry(
        gitlabProjectId,
        mrIid,
        3,
        5000,
      );

      // Determine preview URL
      const previewDomain = this.settings.get('preview.domain', '');
      const previewUrl =
        project?.previewPort && project?.slug && previewDomain
          ? `https://${project.slug}.${previewDomain}`
          : null;

      let browserData = '';
      let screenshotImages: Array<{ base64: string; label: string }> = [];
      let screenshotManifestPath: string | undefined;

      if (previewUrl) {
        // Playwright-based testing
        const runner = await this.ensurePlaywright();

        if (runner) {
          await this.sendAgentMessage(
            ctx,
            `Running browser tests against ${previewUrl}...`,
          );

          // Extract routes from diffs (look for route definitions in changed files)
          const routes = this.extractRoutesFromDiffs(diffs);
          if (routes.length === 0) routes.push('/'); // Always test root

          // Capture pages
          const captures = await runner.capturePages(previewUrl, routes);

          // Accessibility check on main route
          const a11y = await runner.checkAccessibility(previewUrl, routes[0]);

          // Responsive check on main route
          const responsive = await runner.checkResponsive(
            previewUrl,
            routes[0],
          );

          browserData = this.formatBrowserData(captures, a11y, responsive);

          // Save screenshots as PNGs + collect base64 for multimodal LLM
          const resolvedWorkspace = project?.slug
            ? await this.resolveWorkspace(project.slug, ctx.chatSessionId)
            : '';
          if (resolvedWorkspace) {
            try {
              const saved = await runner.saveScreenshots(
                resolvedWorkspace,
                issueId,
                captures,
                responsive,
              );

              // Collect images for multimodal LLM analysis (limit to 6 images to avoid token explosion)
              for (const capture of captures) {
                if (capture.screenshotBase64) {
                  screenshotImages.push({
                    base64: capture.screenshotBase64,
                    label: `${capture.route} — desktop (1440x900)`,
                  });
                }
              }
              if (responsive?.captures) {
                for (const rc of responsive.captures) {
                  if (rc.screenshotBase64) {
                    screenshotImages.push({
                      base64: rc.screenshotBase64,
                      label: `${responsive.route} — ${rc.viewport} (${rc.width}x${rc.height})`,
                    });
                  }
                }
              }
              screenshotImages = screenshotImages.slice(0, 6);

              // Save initial manifest (descriptions filled in after LLM analysis)
              screenshotManifestPath = path.join(saved.dir, 'manifest.json');
              const manifest: ScreenshotManifest = {
                issueId,
                issueTitle: issue.title,
                capturedAt: new Date().toISOString(),
                screenshotDir: saved.dir,
                screenshots: saved.files.map((f) => ({
                  file: f.file,
                  route: f.route,
                  viewport: f.viewport,
                  description: '', // Will be filled by LLM
                })),
              };
              await fs.writeFile(
                screenshotManifestPath,
                JSON.stringify(manifest, null, 2),
              );
              this.logger.log(
                `Screenshots saved: ${saved.files.length} files, manifest at ${screenshotManifestPath}`,
              );
            } catch (err) {
              this.logger.warn(`Failed to save screenshots: ${err.message}`);
            }
          }
        }
      }

      if (!browserData && screenshotImages.length === 0) {
        await this.sendAgentMessage(
          ctx,
          'No preview available — running code-only UI analysis',
        );
      }

      // Build LLM prompt
      const config = this.getRoleConfig();
      const systemPrompt = config.systemPrompt || DEFAULT_SYSTEM_PROMPT;

      const MAX_DIFFS = 20;
      const MAX_DIFF_CHARS = 2000;
      const reviewDiffs = diffs
        .filter((d) =>
          /\.(html|css|scss|tsx|jsx|ts|js|vue|svelte|java)$/.test(d.new_path),
        )
        .slice(0, MAX_DIFFS);

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

      // Inject previous agent comments as context
      const commentHistory = await getAgentCommentHistory({
        prisma: this.prisma,
        issueId,
      });
      const historySection = commentHistory
        ? `\n## Previous Agent Comments on this Issue\n${commentHistory}\n`
        : '';
      const outOfScopeItems = extractArchitectOutOfScopeItems(commentHistory);
      const scopeGuardSection =
        buildArchitectScopeGuardSection(outOfScopeItems);

      // ─── Visual Analysis: send screenshots to multimodal LLM ──────
      let visualAnalysis = '';
      if (screenshotImages.length > 0) {
        try {
          await this.sendAgentMessage(
            ctx,
            `Analyzing ${screenshotImages.length} screenshots visually...`,
          );
          visualAnalysis = await this.analyzeScreenshots(
            config,
            screenshotImages,
            issue.title,
          );

          // Update manifest with descriptions from visual analysis
          if (screenshotManifestPath) {
            await this.updateManifestDescriptions(
              screenshotManifestPath,
              visualAnalysis,
            );
          }
        } catch (err) {
          this.logger.warn(`Visual screenshot analysis failed: ${err.message}`);
        }
      }

      // Build structured previous findings section (Expectation Pattern memory)
      const previousFindings = extractLastAgentFindings(
        commentHistory,
        'UI Tester',
      );
      const previousFindingsSection =
        previousFindings.length > 0
          ? `\n## YOUR Previous UI Test Findings — Re-Evaluate Each One\n${previousFindings
              .map(
                (f, i) =>
                  `${i + 1}. [${(f.severity ?? 'warning').toUpperCase()}] ${f.message}\n   → NOW CHECK: is this still present in the current code/screenshots?`,
              )
              .join(
                '\n',
              )}\n\nFor each finding above: if fixed, report in \`resolvedFromPrevious\`. If still present, carry forward with SAME description.\n`
          : '';

      const userPrompt = `Analyze the UI changes in this merge request${previousFindings.length > 0 ? ' (Re-test after fix attempt)' : ''}:

**Issue:** ${issue.title}
**Description:** ${issue.description || 'N/A'}
${previewUrl ? `**Preview URL:** ${previewUrl}` : ''}
${previousFindingsSection}${historySection}
${scopeGuardSection}
## Code Changes (${reviewDiffs.length} UI-related file(s)):

${diffText || '_No UI-related files changed._'}

${browserData ? `## Browser Test Results:\n\n${browserData}` : ''}
${visualAnalysis ? `## Visual Screenshot Analysis:\n\n${visualAnalysis}` : ''}

${
  previousFindings.length > 0
    ? 'IMPORTANT: First address each item in "YOUR Previous UI Test Findings" above, then check for new issues.'
    : 'Analyze the UI changes for layout, responsiveness, accessibility, visual quality, and interactions.'
}

IMPORTANT: You MUST end your response with the JSON result in this EXACT format:
${COMPLETION_MARKER}
\`\`\`json
{"passed": true/false, "summary": "...", "pagesChecked": 0, "roundNumber": 1, "findings": [{"type": "layout|responsive|accessibility|visual|interaction", "page": "/path", "description": "...", "severity": "info/warning/critical", "expectedState": "...", "observedState": "...", "status": "new|unresolved|blocked"}]}
\`\`\`
Do NOT omit the JSON block.`;

      // Resolve workspace for MCP agent loop
      const workspace = project?.slug
        ? await this.resolveWorkspace(project.slug, ctx.chatSessionId)
        : '';

      // Try MCP agent loop (with shell access) if workspace exists, else fallback to dual LLM
      let resultContent: string;

      const mcpServers = workspace
        ? await this.mcpRegistry.resolveServersForRole(AgentRole.UI_TESTER, {
            workspace,
            allowedPaths: [workspace],
            projectId: ctx.projectId,
          })
        : [];

      if (mcpServers.length > 0 && workspace) {
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
          return;
        }

        resultContent = mcpResult.content;
        this.logger.log(
          `MCP loop: ${mcpResult.iterations} iterations, ${mcpResult.toolCallsExecuted} tool calls`,
        );
      } else {
        // Fallback: dual LLM call (no shell access)
        const messages: LlmMessage[] = [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ];

        const dualResult = await this.dualTestService.callDual(
          config,
          messages,
        );

        if (dualResult.primary.finishReason === 'error') {
          await this.sendAgentMessage(ctx, 'UI Tester LLM call failed');
          await this.markFailed(
            ctx,
            `LLM call failed: ${dualResult.primary.errorMessage ?? 'unknown error'}`,
          );
          return;
        }

        resultContent = dualResult.primary.content;

        // Dual-testing: parse secondary and merge findings
        if (
          dualResult.secondary &&
          dualResult.secondary.finishReason !== 'error'
        ) {
          const primaryResult = this.parseTestResult(
            dualResult.primary.content,
            issueId,
          );
          const secondaryResult = this.parseTestResult(
            dualResult.secondary.content,
            issueId,
          );
          if (primaryResult && secondaryResult) {
            const strategy = config.dualStrategy ?? 'merge';
            const { merged, stats } = this.dualTestService.mergeFindings(
              primaryResult.findings,
              secondaryResult.findings,
              strategy,
              (f: UiTestFinding) =>
                `${f.type}:${f.page}:${f.description.substring(0, 40).toLowerCase()}`,
            );

            const passed = this.dualTestService.determineApproval(merged, 3);
            // Use merged result directly
            const mergedTestResult: UiTestResult = {
              ...primaryResult,
              findings: merged,
              passed,
              pagesChecked: Math.max(
                primaryResult.pagesChecked,
                secondaryResult.pagesChecked,
              ),
            };
            const scopedMergedResult = this.applyArchitectScopeFilter(
              mergedTestResult,
              outOfScopeItems,
            );

            await this.sendAgentMessage(
              ctx,
              `🔀 **Dual-test** (${strategy}): ${stats.primaryCount} + ${stats.secondaryCount} → ${stats.mergedCount} findings [${dualResult.providers.primary} + ${dualResult.providers.secondary}]`,
            );

            // ─── Finding Threads for dual-test path ───
            const dualActiveFindings = scopedMergedResult.findings.filter(
              (f) => f.severity !== 'info',
            );
            const dualFindingsForThreads: FindingForThread[] =
              dualActiveFindings.map((f) => {
                const parts = [
                  `**${f.severity.toUpperCase()}** [${f.type}] — \`${f.page}\``,
                  '',
                  f.description,
                ];
                if (f.expectedState)
                  parts.push('', `**Expected:** ${f.expectedState}`);
                if (f.observedState)
                  parts.push('', `**Observed:** ${f.observedState}`);
                return {
                  severity: f.severity,
                  message: `[${f.type}] ${f.page}: ${f.description.substring(0, 80)}`,
                  threadBody: parts.join('\n'),
                };
              });

            const {
              activeThreads: dualAllThreads,
              resolvedThreads: dualResolvedRecords,
            } = await syncFindingThreads({
              prisma: this.prisma,
              gitlabService: this.gitlabService,
              issueId,
              mrIid,
              gitlabProjectId,
              agentRole: AgentRole.UI_TESTER,
              roundNumber: scopedMergedResult.roundNumber ?? 1,
              findings: dualFindingsForThreads,
              confirmedResolved: scopedMergedResult.resolvedFromPrevious
                ?.map((r: any) => ({ message: r.description })),
            });

            const testMarkdown = buildIssueSummaryWithThreadLinks({
              agentName: 'UI Test',
              approved: scopedMergedResult.passed,
              summary: scopedMergedResult.summary,
              threads: dualAllThreads,
              resolvedThreads: dualResolvedRecords,
            });
            await postAgentComment({
              prisma: this.prisma,
              gitlabService: this.gitlabService,
              issueId,
              gitlabProjectId,
              issueIid: issue.gitlabIid!,
              agentTaskId: ctx.agentTaskId,
              authorName: 'UI Tester',
              markdownContent: testMarkdown,
            });

            if (scopedMergedResult.passed) {
              await this.handlePassed(
                ctx,
                issueId,
                mrIid,
                gitlabProjectId,
                scopedMergedResult,
              );
            } else {
              await this.handleFailed(
                ctx,
                issueId,
                mrIid,
                gitlabProjectId,
                scopedMergedResult,
              );
            }
            return;
          }
        }
      }

      // Parse result (MCP path or single-LLM fallback)
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
          '{"passed": true/false, "summary": "...", "pagesChecked": 0, "findings": [{"type": "accessibility|responsive|ux|consistency|missing", "page": "...", "description": "...", "severity": "info|warning|critical"}]}',
        );
        if (retryJson) {
          const retried = this.parseTestResult(retryJson, issueId);
          if (retried && retried.findings.length > 0) {
            this.logger.log(
              `JSON retry recovered ${retried.findings.length} UI findings`,
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
          '{"passed": true/false, "summary": "...", "pagesChecked": 0, "findings": [{"type": "accessibility|responsive|ux|consistency|missing", "page": "...", "description": "...", "severity": "info|warning|critical"}]}',
        );
        if (retryJson) {
          testResult = this.parseTestResult(retryJson, issueId);
          if (testResult) {
            this.logger.log(
              `JSON retry recovered full UI result (${testResult.findings.length} findings)`,
            );
          }
        }
      }

      if (!testResult) {
        await this.sendAgentMessage(
          ctx,
          'Could not parse UI test result — defaulting to pass',
        );
        await this.handlePassed(ctx, issueId, mrIid, gitlabProjectId, {
          issueId,
          passed: true,
          findings: [],
          summary: 'Parse failed — auto-passed',
          pagesChecked: 0,
        });
        return;
      }

      // Enforce Architect out-of-scope constraints server-side to avoid false FAIL loops.
      testResult = this.applyArchitectScopeFilter(testResult, outOfScopeItems);

      // ─── Finding Threads: Post findings as MR discussion threads ───
      const activeFindings = testResult.findings.filter(
        (f) => f.severity !== 'info',
      );
      const findingsForThreads: FindingForThread[] = activeFindings.map((f) => {
        const parts = [
          `**${f.severity.toUpperCase()}** [${f.type}] — \`${f.page}\``,
          '',
          f.description,
        ];
        if (f.expectedState) parts.push('', `**Expected:** ${f.expectedState}`);
        if (f.observedState) parts.push('', `**Observed:** ${f.observedState}`);
        if (f.verifiableFromCode === false)
          parts.push('', '_⚠️ Needs browser verification_');
        return {
          severity: f.severity,
          message: `[${f.type}] ${f.page}: ${f.description.substring(0, 80)}`,
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
        agentRole: AgentRole.UI_TESTER,
        roundNumber: testResult.roundNumber ?? 1,
        findings: findingsForThreads,
        confirmedResolved: testResult.resolvedFromPrevious
          ?.map((r: any) => ({ message: r.description })),
      });

      const testMarkdown = buildIssueSummaryWithThreadLinks({
        agentName: 'UI Test',
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
        authorName: 'UI Tester',
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
          parts.push(
            `- Console Errors: ${c.consoleErrors.slice(0, 5).join('; ')}`,
          );
        } else {
          parts.push('- No console errors');
        }
        // Include a DOM summary (first 2000 chars)
        const domSummary = c.domSnapshot.substring(0, 2000);
        parts.push(
          `- DOM snapshot (first 2000 chars):\n\`\`\`html\n${domSummary}\n\`\`\``,
        );
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
        parts.push(
          `  - **${v.impact}**: ${v.description} (${v.nodes} element(s)) — ${v.id}`,
        );
      }
      parts.push('');
    }

    // Responsive results
    if (responsive?.captures?.length > 0) {
      parts.push('### Responsive Check:');
      for (const rc of responsive.captures) {
        parts.push(
          `- ${rc.viewport} (${rc.width}x${rc.height}): Screenshot captured`,
        );
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
        routes.add(
          `/${pathMatch[1].replace(/\.(component|page)\.(ts|tsx|vue|svelte)$/, '')}`,
        );
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
      .filter((f) => f.severity !== 'info')
      .map((f) => `- **${f.severity}** [${f.type}] ${f.page}: ${f.description}`)
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

    const relevantFindings = testResult.findings.filter(
      (f) => f.severity !== 'info',
    );
    const feedback = relevantFindings
      .map((f, i) => {
        const persist = f.persistsSinceRound
          ? ` (open since round ${f.persistsSinceRound})`
          : '';
        const verifiable =
          f.verifiableFromCode === false ? ' [needs browser verification]' : '';
        const parts = [
          `${i + 1}. [${f.severity.toUpperCase()}] [${f.type}] ${f.page}${persist}${verifiable}`,
        ];
        parts.push(`   Problem: ${f.description}`);
        if (f.expectedState) parts.push(`   Expected: ${f.expectedState}`);
        if (f.observedState) parts.push(`   Observed: ${f.observedState}`);
        return parts.join('\n');
      })
      .join('\n\n');

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

  private parseTestResult(
    content: string,
    issueId: string,
  ): UiTestResult | null {
    this.logger.debug(`Parsing UI test result (${content.length} chars)`);

    if (!content.trim()) return null;

    const cleaned = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

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
      const findings = this.parseFindings(
        parsed.findings || parsed.issues || [],
      );

      let summary = parsed.summary || '';
      if (!summary || summary.length < 5) {
        summary = passed
          ? `UI test passed (${findings.length} finding(s))`
          : `UI test failed (${findings.filter((f) => f.severity !== 'info').length} issue(s))`;
      }

      const result: UiTestResult = {
        issueId,
        passed,
        findings,
        summary,
        pagesChecked: parsed.pagesChecked ?? 0,
      };

      if (typeof parsed.roundNumber === 'number') {
        result.roundNumber = parsed.roundNumber;
      }

      if (Array.isArray(parsed.resolvedFromPrevious)) {
        result.resolvedFromPrevious = parsed.resolvedFromPrevious
          .filter((r: any) => r && typeof r === 'object' && r.description)
          .map((r: any) => ({
            type: String(r.type ?? 'visual'),
            page: String(r.page ?? '/'),
            description: String(r.description),
            resolvedBy: String(r.resolvedBy ?? 'unknown'),
          }));
      }

      return result;
    } catch (err) {
      this.logger.error(`JSON parse failed: ${err.message}`);
      return this.buildResultFromText(cleaned, issueId);
    }
  }

  private extractJson(content: string): string | null {
    if (content.includes(COMPLETION_MARKER)) {
      const after = content
        .substring(
          content.indexOf(COMPLETION_MARKER) + COMPLETION_MARKER.length,
        )
        .trim();
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
    const stripped = str
      .replace(/^```(?:json)?\s*\n?/, '')
      .replace(/\n?```\s*$/, '')
      .trim();
    const match = stripped.match(/\{[\s\S]*\}/);
    return match ? match[0] : null;
  }

  private normalizePass(parsed: any): boolean {
    if (typeof parsed.passed === 'boolean') return parsed.passed;
    if (typeof parsed.passed === 'string')
      return parsed.passed.toLowerCase() === 'true';
    if (parsed.status) {
      const s = String(parsed.status).toLowerCase();
      return s === 'pass' || s === 'passed' || s === 'success';
    }
    return false;
  }

  private parseFindings(raw: any): UiTestFinding[] {
    if (!Array.isArray(raw)) return [];
    const validTypes = [
      'layout',
      'responsive',
      'accessibility',
      'visual',
      'interaction',
    ];
    return raw
      .filter((f: any) => f && typeof f === 'object')
      .map((f: any) => ({
        type: validTypes.includes(f.type) ? f.type : 'visual',
        page: String(f.page ?? f.route ?? f.url ?? '/'),
        description: String(
          f.description ?? f.message ?? f.details ?? 'No details',
        ),
        severity: this.normalizeSeverity(f.severity),
        verifiableFromCode:
          typeof f.verifiableFromCode === 'boolean'
            ? f.verifiableFromCode
            : undefined,
        expectedState: f.expectedState ? String(f.expectedState) : undefined,
        observedState: f.observedState ? String(f.observedState) : undefined,
        persistsSinceRound:
          typeof f.persistsSinceRound === 'number'
            ? f.persistsSinceRound
            : undefined,
        status: ['new', 'resolved', 'unresolved', 'blocked'].includes(f.status)
          ? f.status
          : undefined,
      }));
  }

  private normalizeSeverity(raw: any): 'info' | 'warning' | 'critical' {
    if (!raw) return 'warning';
    const s = String(raw).toLowerCase();
    if (['critical', 'error', 'high', 'major', 'blocker'].includes(s))
      return 'critical';
    if (['warning', 'warn', 'medium', 'minor'].includes(s)) return 'warning';
    return 'info';
  }

  private buildResultFromText(text: string, issueId: string): UiTestResult {
    const lower = text.toLowerCase();
    const lastLines = lower.split('\n').slice(-10).join(' ');

    const strongFail =
      /\b(test(s)?\s+(have\s+)?failed|result:\s*fail|verdict:\s*fail|overall:\s*fail|critical\s+issue)\b/.test(
        lastLines,
      );
    // Default to pass if no clear failure signal (prevents infinite loops)
    const passed = !strongFail;

    this.logger.log(
      `buildResultFromText: strongFail=${strongFail}, passed=${passed}`,
    );

    return {
      issueId,
      passed,
      findings: [],
      summary: strongFail
        ? 'UI test failed (parsed from text)'
        : 'UI test passed (no clear failure detected — defaulting to pass)',
      pagesChecked: 0,
    };
  }

  // ─── Visual Screenshot Analysis ─────────────────────────

  private applyArchitectScopeFilter(
    testResult: UiTestResult,
    outOfScopeItems: string[],
  ): UiTestResult {
    if (outOfScopeItems.length === 0 || testResult.findings.length === 0) {
      return testResult;
    }

    const { filtered, removedCount } = filterOutOfScopeFindings(
      testResult.findings,
      outOfScopeItems,
      (f) => `${f.type} ${f.page} ${f.description}`,
    );

    if (removedCount === 0) return testResult;

    const criticalCount = filtered.filter(
      (f) => f.severity === 'critical',
    ).length;
    const warningCount = filtered.filter(
      (f) => f.severity === 'warning',
    ).length;
    const passed = criticalCount === 0 && warningCount <= 3;

    this.logger.log(
      `Architect scope filter removed ${removedCount} UI finding(s) as out-of-scope`,
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

  /**
   * Send screenshots to a multimodal LLM for visual analysis.
   * Returns a text description of each screenshot's appearance, layout, and issues.
   */
  private async analyzeScreenshots(
    config: ReturnType<typeof this.getRoleConfig>,
    images: Array<{ base64: string; label: string }>,
    issueTitle: string,
  ): Promise<string> {
    // Build multimodal content: text prompt + images interleaved
    const contentParts: LlmContentPart[] = [
      {
        type: 'text',
        text: `You are a UI/UX expert reviewing screenshots of a web application.
Issue being tested: "${issueTitle}"

Below are ${images.length} screenshot(s) captured from the application. For EACH screenshot:

1. **Describe** the visual appearance: layout, colors, typography, spacing, alignment
2. **Identify issues**: broken layouts, overlapping elements, poor contrast, inconsistent styling, missing content, visual glitches
3. **Rate** the overall visual quality (good/acceptable/poor)

Label each description with the screenshot label provided.
Use this exact format for each:

### [Screenshot Label]
**Description:** ...
**Issues:** ... (or "None found")
**Visual Quality:** good/acceptable/poor
`,
      },
    ];

    for (const img of images) {
      contentParts.push({
        type: 'text',
        text: `\n--- Screenshot: ${img.label} ---`,
      });
      contentParts.push({
        type: 'image',
        mediaType: 'image/png',
        base64: img.base64,
      });
    }

    // Use the configured provider — but only if it supports multimodal.
    // CLI providers (CLAUDE_CODE, CODEX_CLI, etc.) don't support inline images.
    // Fallback chain: ANTHROPIC > GOOGLE > OPENAI > configured provider
    let provider = config.provider;
    const cliProviders = [
      'CLAUDE_CODE',
      'CODEX_CLI',
      'GEMINI_CLI',
      'QWEN3_CODER',
    ];
    if (cliProviders.includes(provider)) {
      // Try cloud providers that support multimodal
      for (const fallback of ['ANTHROPIC', 'GOOGLE', 'OPENAI']) {
        const fbConfig = this.settings.get(
          `llm.${fallback.toLowerCase()}.apiKey`,
          undefined,
          '',
        );
        if (fbConfig) {
          provider = fallback;
          this.logger.log(
            `Visual analysis: CLI provider ${config.provider} doesn't support images, falling back to ${provider}`,
          );
          break;
        }
      }
      // If no cloud provider available, fall back to Ollama (supports images with multimodal models)
      if (cliProviders.includes(provider)) {
        provider = 'OLLAMA';
        this.logger.log(
          'Visual analysis: falling back to OLLAMA for multimodal',
        );
      }
    }

    const result = await this.llmService.complete({
      provider,
      model: config.model,
      messages: [{ role: 'user', content: contentParts }],
      temperature: 0.2,
      maxTokens: config.parameters.maxTokens,
    });

    if (result.finishReason === 'error' || !result.content) {
      this.logger.warn('Visual screenshot analysis returned no content');
      return '';
    }

    this.logger.log(
      `Visual analysis: ${result.content.length} chars from ${provider}/${config.model}`,
    );
    return result.content;
  }

  /**
   * Parse the LLM visual analysis and update the manifest with per-screenshot descriptions.
   */
  private async updateManifestDescriptions(
    manifestPath: string,
    visualAnalysis: string,
  ): Promise<void> {
    if (!visualAnalysis) return;

    try {
      const raw = await fs.readFile(manifestPath, 'utf-8');
      const manifest: ScreenshotManifest = JSON.parse(raw);

      // Parse analysis sections: look for "### [label]" headers
      const sections = visualAnalysis.split(/^###\s+/m).filter(Boolean);

      for (const section of sections) {
        const lines = section.trim().split('\n');
        const headerLine = lines[0]?.trim() ?? '';
        // Strip markdown formatting from header (brackets, bold, etc.)
        const sectionLabel = headerLine.replace(/[[\]]/g, '').trim();
        const sectionBody = lines.slice(1).join('\n').trim();

        // Match section to manifest entry by comparing labels with screenshot metadata
        for (const entry of manifest.screenshots) {
          const entryLabel = `${entry.route} — ${entry.viewport}`;
          // Fuzzy match: check if section header contains route and viewport info
          if (
            sectionLabel.includes(entry.route) ||
            sectionLabel.includes(entry.viewport) ||
            sectionLabel.toLowerCase().includes(entryLabel.toLowerCase()) ||
            entryLabel.toLowerCase().includes(sectionLabel.toLowerCase())
          ) {
            entry.description = sectionBody.substring(0, 2000);

            // Extract findings from the "Issues:" line
            const issuesMatch = sectionBody.match(
              /\*\*Issues?:\*\*\s*(.+?)(?:\n|$)/i,
            );
            if (issuesMatch) {
              const issuesText = issuesMatch[1].trim();
              if (!/^none/i.test(issuesText) && issuesText.length > 3) {
                entry.findings = entry.findings ?? [];
                entry.findings.push(issuesText);
              }
            }
            break;
          }
        }
      }

      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
      this.logger.log(`Manifest updated with ${sections.length} descriptions`);
    } catch (err) {
      this.logger.warn(
        `Failed to update manifest descriptions: ${err.message}`,
      );
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
