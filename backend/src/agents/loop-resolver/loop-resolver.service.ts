import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { GitlabService } from '../../gitlab/gitlab.service';
import { LlmService } from '../../llm/llm.service';
import { SystemSettingsService } from '../../settings/system-settings.service';
import { postAgentComment, getAgentCommentHistory } from '../agent-comment.utils';
import {
  AgentRole,
  AgentTaskType,
  AgentTaskStatus,
  AgentStatus,
} from '@prisma/client';

export interface LoopAnalysis {
  loopDetected: boolean;
  rootCause: string;
  action: 'clarify_issue' | 'declassify_findings' | 'none';
  updatedDescription?: string;
  clarificationComment: string;
  findingsToResolve?: string[];
}

@Injectable()
export class LoopResolverService {
  private readonly logger = new Logger(LoopResolverService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gitlabService: GitlabService,
    private readonly llm: LlmService,
    private readonly settings: SystemSettingsService,
  ) {}

  /**
   * Analyze a looping issue and attempt to resolve it by clarifying requirements.
   * Returns a LoopAnalysis with actions taken (issue-desc update, comment, finding resolution).
   */
  async analyze(
    issueId: string,
    projectId: string,
    currentFeedback: string,
    feedbackSource: string,
  ): Promise<LoopAnalysis> {
    const noAction: LoopAnalysis = {
      loopDetected: false,
      rootCause: '',
      action: 'none',
      clarificationComment: '',
    };

    let taskId: string | undefined;

    try {
      // 1. Load issue with project context
      const issue = await this.prisma.issue.findUnique({
        where: { id: issueId },
        include: {
          project: {
            select: { gitlabProjectId: true, name: true },
          },
        },
      });
      if (!issue) return noAction;

      // 2. Load persistent unresolved findings
      const unresolvedFindings = await this.prisma.findingThread.findMany({
        where: { issueId, resolved: false },
        orderBy: { createdAt: 'asc' },
      });

      // 3. Load agent comment history
      const commentHistory = await getAgentCommentHistory({
        prisma: this.prisma,
        issueId,
        maxChars: this.settings.getPipelineConfig().maxHistoryChars ?? 60_000,
      });

      // 4. Count fix attempts by source
      const fixTasks = await this.prisma.agentTask.findMany({
        where: { issueId, type: AgentTaskType.FIX_CODE },
        orderBy: { createdAt: 'asc' },
        select: { id: true, createdAt: true },
      });

      // 5. Build LLM prompt
      const findingSummary = unresolvedFindings.length > 0
        ? unresolvedFindings
            .map(
              (f, i) =>
                `${i + 1}. [${f.severity}] ${f.message} (round ${f.roundNumber}, fingerprint: ${f.fingerprint})`,
            )
            .join('\n')
        : 'No tracked findings in DB (findings may be in agent comments only).';

      const systemPrompt = `You are the Loop Resolver for VibCode Hub's AI development pipeline.

A fix loop has been detected: the Coder and Reviewer/Tester have been going back and forth on the same issue for ${fixTasks.length} rounds without resolution.

Your job is NOT to write code. Your job is to analyze WHY the loop is happening and fix it by clarifying the issue requirements.

Common root causes:
1. Contradictory requirements in the issue description (e.g. "call super first" but also "add explicit paths" when super already handles them)
2. Reviewer/tester flagging something the framework handles automatically (false positive due to incomplete knowledge)
3. Requirements that are impossible or conflicting given the tech stack constraints
4. Ambiguous acceptance criteria that can be interpreted multiple ways
5. Missing context in the issue that would help the Coder understand the correct approach

Your output MUST be valid JSON matching this schema:
{
  "loopDetected": true,
  "rootCause": "Clear explanation of why the loop is happening",
  "action": "clarify_issue" | "declassify_findings" | "none",
  "updatedDescription": "The full updated issue description (only if action=clarify_issue)",
  "clarificationComment": "A markdown comment to post on the issue explaining what was wrong and what changed",
  "findingsToResolve": ["fingerprint1", "fingerprint2"] // only if action=declassify_findings
}

Rules:
- If the issue description has contradictions, fix them in updatedDescription (action=clarify_issue)
- If findings are false positives (framework handles it), mark them for resolution (action=declassify_findings)
- If you cannot determine the cause, use action=none and explain in rootCause
- Keep the original intent and structure of the issue description — only fix contradictions
- Be specific in your clarificationComment so the Coder knows exactly what changed and why`;

      const userPrompt = `## Issue: ${issue.title}

### Current Description:
${issue.description}

### Unresolved Findings (${unresolvedFindings.length}):
${findingSummary}

### Fix Attempts: ${fixTasks.length} rounds

### Latest Feedback (source: ${feedbackSource}):
${currentFeedback.substring(0, 2000)}

### Recent Agent Comment History (last entries):
${commentHistory.slice(-3000)}

Analyze the root cause of this loop and produce a JSON response.`;

      // 6. Get Architect config for model (needs good reasoning)
      const architectConfig = this.settings.getAgentRoleConfig('ARCHITECT');

      // 7. Create visible AgentTask
      let architectInstance = await this.prisma.agentInstance.findFirst({
        where: {
          projectId,
          role: AgentRole.ARCHITECT,
          status: { in: [AgentStatus.IDLE, AgentStatus.WORKING] },
        },
      });
      if (!architectInstance) {
        architectInstance = await this.prisma.agentInstance.create({
          data: {
            projectId,
            role: AgentRole.ARCHITECT,
            provider: architectConfig.provider as any,
            model: architectConfig.model,
            status: AgentStatus.IDLE,
          },
        });
      }

      const agentTask = await this.prisma.agentTask.create({
        data: {
          agentId: architectInstance.id,
          issueId,
          type: AgentTaskType.RESOLVE_LOOP,
          status: AgentTaskStatus.RUNNING,
          startedAt: new Date(),
        },
      });
      taskId = agentTask.id;

      this.logger.log(
        `Loop Resolver started for issue ${issueId} (${fixTasks.length} fix attempts, task ${agentTask.id})`,
      );

      // 8. LLM call
      const response = await this.llm.complete({
        provider: architectConfig.provider,
        model: architectConfig.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.3,
        maxTokens: 4096,
      });

      // 9. Check for LLM errors
      if (response.finishReason === 'error' || !response.content) {
        this.logger.warn(
          `Loop Resolver LLM call failed: ${response.errorMessage ?? 'empty response'} — skipping`,
        );
        await this.completeTask(taskId, AgentTaskStatus.COMPLETED, {
          rootCause: 'LLM call failed',
          action: 'none',
        });
        return noAction;
      }

      // 10. Parse response — robust JSON extraction
      let analysis: LoopAnalysis;
      try {
        analysis = this.extractJson(response.content);
      } catch (parseErr) {
        this.logger.warn(
          `Loop Resolver JSON parse failed: ${parseErr.message} — treating as no-action`,
        );
        analysis = {
          loopDetected: true,
          rootCause: response.content.substring(0, 500),
          action: 'none',
          clarificationComment: '',
        };
      }

      // 10. Execute actions
      if (analysis.action === 'clarify_issue' && analysis.updatedDescription) {
        // Update issue description in DB
        await this.prisma.issue.update({
          where: { id: issueId },
          data: { description: analysis.updatedDescription },
        });

        // Update GitLab issue description
        if (issue.gitlabIid && issue.project.gitlabProjectId) {
          await this.gitlabService
            .updateIssue(issue.project.gitlabProjectId, issue.gitlabIid, {
              description: analysis.updatedDescription,
            })
            .catch((err) =>
              this.logger.warn(`GitLab issue update failed: ${err.message}`),
            );
        }

        this.logger.log(
          `Loop Resolver: Updated issue description for ${issueId}`,
        );
      }

      if (
        analysis.action === 'declassify_findings' &&
        Array.isArray(analysis.findingsToResolve) &&
        analysis.findingsToResolve.length
      ) {
        // Resolve findings by fingerprint (cap at 50 to prevent runaway LLM output)
        const fingerprints = analysis.findingsToResolve
          .filter((fp): fp is string => typeof fp === 'string')
          .slice(0, 50);
        for (const fingerprint of fingerprints) {
          await this.prisma.findingThread
            .updateMany({
              where: { issueId, fingerprint, resolved: false },
              data: { resolved: true },
            })
            .catch(() => {});
        }
        this.logger.log(
          `Loop Resolver: Resolved ${analysis.findingsToResolve.length} findings for ${issueId}`,
        );
      }

      // 11. Post clarification comment (always, so it's visible)
      if (analysis.clarificationComment) {
        const commentBody = [
          `## Loop Resolver — Intervention (Round ${fixTasks.length})`,
          '',
          `**Root Cause:** ${analysis.rootCause}`,
          '',
          `**Action:** ${analysis.action === 'clarify_issue' ? 'Issue description updated' : analysis.action === 'declassify_findings' ? 'False-positive findings resolved' : 'Analysis only (no changes)'}`,
          '',
          analysis.clarificationComment,
        ].join('\n');

        if (issue.gitlabIid && issue.project.gitlabProjectId) {
          await postAgentComment({
            prisma: this.prisma,
            gitlabService: this.gitlabService,
            issueId,
            gitlabProjectId: issue.project.gitlabProjectId,
            issueIid: issue.gitlabIid,
            agentTaskId: agentTask.id,
            authorName: 'Loop Resolver',
            markdownContent: commentBody,
          });
        }
      }

      // 13. Complete task
      await this.completeTask(taskId, AgentTaskStatus.COMPLETED, {
        rootCause: analysis.rootCause,
        action: analysis.action,
        findingsResolved: analysis.findingsToResolve?.length ?? 0,
        descriptionUpdated: analysis.action === 'clarify_issue',
      });

      this.logger.log(
        `Loop Resolver completed for ${issueId}: action=${analysis.action}, rootCause=${analysis.rootCause.substring(0, 100)}`,
      );

      return analysis;
    } catch (err) {
      this.logger.error(`Loop Resolver error for ${issueId}: ${err.message}`);
      // Prevent zombie task — mark as COMPLETED even on error
      if (taskId) {
        await this.completeTask(taskId, AgentTaskStatus.COMPLETED, {
          error: err.message,
        });
      }
      return noAction;
    }
  }

  /**
   * Robust JSON extraction: tries multiple strategies to find valid JSON.
   * Opus tends to embed JSON in narrative text — scanning backwards for the
   * last balanced {} pair catches it reliably.
   */
  private extractJson(raw: string): LoopAnalysis {
    const stripped = raw
      .replace(/```(?:json)?\s*/g, '')
      .replace(/```\s*/g, '')
      .trim();

    // Strategy 1: Find the LAST balanced {} pair (Opus puts JSON at the end)
    let depth = 0;
    let end = -1;
    let start = -1;
    for (let i = stripped.length - 1; i >= 0; i--) {
      if (stripped[i] === '}') {
        if (depth === 0) end = i;
        depth++;
      } else if (stripped[i] === '{') {
        depth--;
        if (depth === 0 && end !== -1) {
          start = i;
          break;
        }
      }
    }

    if (start !== -1 && end !== -1) {
      try {
        const parsed = JSON.parse(stripped.substring(start, end + 1));
        if (typeof parsed.loopDetected === 'boolean' || typeof parsed.action === 'string') {
          return parsed;
        }
      } catch { /* try next strategy */ }
    }

    // Strategy 2: Greedy regex (fallback)
    const jsonMatch = stripped.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (typeof parsed.action === 'string') return parsed;
    }

    throw new Error('No valid LoopAnalysis JSON found in response');
  }

  private async completeTask(
    taskId: string | undefined,
    status: AgentTaskStatus,
    output: Record<string, unknown>,
  ): Promise<void> {
    if (!taskId) return;
    await this.prisma.agentTask
      .update({
        where: { id: taskId },
        data: {
          status,
          completedAt: new Date(),
          output: output as any,
        },
      })
      .catch((err) =>
        this.logger.warn(`Failed to update task ${taskId}: ${err.message}`),
      );
  }
}
