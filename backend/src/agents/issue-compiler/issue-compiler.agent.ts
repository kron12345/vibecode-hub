import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import { SystemSettingsService } from '../../settings/system-settings.service';
import { ChatService } from '../../chat/chat.service';
import { ChatGateway } from '../../chat/chat.gateway';
import { LlmService } from '../../llm/llm.service';
import { GitlabService } from '../../gitlab/gitlab.service';
import { IssuesService } from '../../issues/issues.service';
import { LlmMessage } from '../../llm/llm.interfaces';
import { BaseAgent, AgentContext, sanitizeJsonOutput } from '../agent-base';
import { loadPrompt } from '../prompt-loader';
import { MonitorGateway } from '../../monitor/monitor.gateway';
import {
  InterviewResult,
  FeatureInterviewResult,
} from '../interviewer/interview-result.interface';
import { IssueCompilerResult } from './issue-compiler-result.interface';
import {
  COMPLETION_MARKER,
  ISSUE_COMPLETION_INSTRUCTIONS,
  normalizeResult,
  parseCompilationJson,
} from './issue-compiler-result';
import {
  AgentRole,
  AgentStatus,
  AgentTaskStatus,
  AgentTaskType,
  ChatSessionType,
  IssuePriority,
} from '@prisma/client';

const DEFAULT_SYSTEM_PROMPT = loadPrompt('issue-compiler');

@Injectable()
export class IssueCompilerAgent extends BaseAgent {
  readonly role = AgentRole.ISSUE_COMPILER;
  protected readonly logger = new Logger(IssueCompilerAgent.name);

  constructor(
    prisma: PrismaService,
    settings: SystemSettingsService,
    chatService: ChatService,
    chatGateway: ChatGateway,
    llmService: LlmService,
    private readonly gitlabService: GitlabService,
    private readonly issuesService: IssuesService,
    monitorGateway: MonitorGateway,
    private readonly eventEmitter: EventEmitter2,
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

  /** Run the full issue compilation pipeline */
  async runCompilation(ctx: AgentContext): Promise<void> {
    try {
      await this.updateStatus(ctx, AgentStatus.WORKING);
      await this.sendAgentMessage(
        ctx,
        '📋 **Issue Compiler** starting — analyzing features and creating issues...',
      );

      // Step 1: Load project data
      const projectData = await this.loadProjectData(ctx);
      if (!projectData) return;

      // Step 2: Call LLM to compile issues
      const rawResult = await this.callLlmForCompilation(ctx, projectData);
      if (!rawResult) return;

      // Step 3: Normalize result
      const compiledResult = normalizeResult(rawResult);

      // Step 4: Create milestones, issues + tasks in DB + GitLab
      await this.createMilestonesAndIssues(ctx, projectData, compiledResult);

      // Step 5: Finalize
      await this.finalize(ctx, compiledResult);
    } catch (err) {
      this.logger.error(`Issue compilation crashed: ${err.message}`, err.stack);
      await this.sendAgentMessage(
        ctx,
        `❌ **Issue Compiler** encountered an unexpected error: ${err.message}`,
      );
      await this.markFailed(ctx, `Unexpected error: ${err.message}`);
    }
  }

  // ─── Step 1: Load Project Data ──────────────────────────────

  private async loadProjectData(ctx: AgentContext) {
    try {
      const project = await this.prisma.project.findUnique({
        where: { id: ctx.projectId },
      });
      if (!project) throw new Error('Project not found');

      // Determine if we're running in a dev session
      let isDevSession = false;
      let chatSessionId: string | undefined;
      if (ctx.chatSessionId) {
        const session = await this.prisma.chatSession.findUnique({
          where: { id: ctx.chatSessionId },
          select: { type: true, id: true },
        });
        isDevSession = session?.type === ChatSessionType.DEV_SESSION;
        if (isDevSession) chatSessionId = session!.id;
      }

      let interviewResult: InterviewResult;

      if (isDevSession) {
        const featureTask = await this.prisma.agentTask.findFirst({
          where: {
            type: AgentTaskType.FEATURE_INTERVIEW,
            status: AgentTaskStatus.COMPLETED,
            agent: { projectId: ctx.projectId },
          },
          orderBy: { completedAt: 'desc' },
          select: { output: true },
        });

        const featureResult =
          featureTask?.output as unknown as FeatureInterviewResult;
        if (!featureResult?.features?.length) {
          throw new Error('No features found in feature interview result');
        }

        const projectTechStack =
          (project.techStack as unknown as InterviewResult) || {};
        interviewResult = {
          description:
            featureResult.sessionGoal || projectTechStack.description || '',
          techStack: projectTechStack.techStack || {},
          features: featureResult.features,
        };

        // Also read ENVIRONMENT.md for tech context (Wiki-First)
        const workspace = await this.resolveWorkspace(
          project.slug,
          ctx.chatSessionId,
        );
        const envDoc = await this.readEnvironment(
          this.gitlabService,
          project.gitlabProjectId,
          workspace,
        );
        if (envDoc) {
          interviewResult.description = `${featureResult.sessionGoal}\n\n## Environment Context\n${envDoc.substring(0, 3000)}`;
        }
      } else {
        interviewResult = project.techStack as unknown as InterviewResult;
        if (!interviewResult?.features?.length) {
          throw new Error('No features found in interview result');
        }
      }

      let gitlabProjectPath: string | null = null;
      if (project.gitlabProjectId) {
        try {
          const glProject = await this.gitlabService.getProject(
            project.gitlabProjectId,
          );
          gitlabProjectPath = glProject.path_with_namespace;
        } catch (err) {
          this.logger.warn(`Could not load GitLab project: ${err.message}`);
        }
      }

      await this.log(ctx.agentTaskId, 'INFO', 'Project data loaded', {
        features: interviewResult.features.length,
        hasGitlab: !!gitlabProjectPath,
        isDevSession,
      });

      return {
        project,
        interviewResult,
        gitlabProjectId: project.gitlabProjectId,
        gitlabProjectPath,
        chatSessionId,
      };
    } catch (err) {
      await this.sendAgentMessage(
        ctx,
        `❌ Failed to load project data: ${err.message}`,
      );
      await this.markFailed(ctx, err.message);
      return null;
    }
  }

  // ─── Step 2: Call LLM ───────────────────────────────────────

  private async callLlmForCompilation(
    ctx: AgentContext,
    projectData: {
      project: { name: string; description: string | null };
      interviewResult: InterviewResult;
    },
  ): Promise<Record<string, any> | null> {
    const { project, interviewResult } = projectData;
    const config = this.getRoleConfig();
    const basePrompt = config.systemPrompt || DEFAULT_SYSTEM_PROMPT;
    const systemPrompt = basePrompt + ISSUE_COMPLETION_INSTRUCTIONS;

    const featureList = interviewResult.features
      .map((f, i) => {
        if (typeof f === 'string') return `${i + 1}. ${f}`;
        const parts = [`${i + 1}. **${f.title}** [${f.priority ?? 'medium'}]`];
        if (f.description) parts.push(`   ${f.description}`);
        if (f.acceptanceCriteria?.length) {
          parts.push(
            `   Acceptance Criteria: ${f.acceptanceCriteria.join('; ')}`,
          );
        }
        return parts.join('\n');
      })
      .join('\n');

    const techInfo = [
      `Framework: ${interviewResult.techStack?.framework ?? 'N/A'}`,
      `Language: ${interviewResult.techStack?.language ?? 'N/A'}`,
      `Backend: ${interviewResult.techStack?.backend ?? 'none'}`,
      `Database: ${interviewResult.techStack?.database ?? 'none'}`,
      interviewResult.techStack?.additional?.length
        ? `Additional: ${interviewResult.techStack.additional.join(', ')}`
        : null,
    ]
      .filter(Boolean)
      .join('\n');

    const userPrompt = `Please compile the following project features into structured GitLab issues with sub-tasks, grouped into milestones (development phases).

**Project:** ${project.name}
**Description:** ${project.description || interviewResult.description || 'N/A'}

**Tech Stack:**
${techInfo}

**Features to compile:**
${featureList}

Create well-structured milestones with issues and actionable tasks. Group logically: setup/config first, then core features, then polish/extras.

IMPORTANT: Respond with ONLY the JSON object. No prose, no explanation, no markdown outside the JSON. Start your response with \`\`\`json and end with \`\`\`.`;

    const messages: LlmMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];

    await this.sendAgentMessage(
      ctx,
      `🤖 Analyzing ${interviewResult.features.length} features...`,
    );

    const MAX_RETRIES = 3;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const result = await this.callLlm(messages);

      if (result.finishReason === 'error') {
        if (attempt < MAX_RETRIES) {
          this.logger.warn(
            `LLM call failed (attempt ${attempt}/${MAX_RETRIES}), retrying...`,
          );
          await this.sendAgentMessage(
            ctx,
            `⚠️ LLM call failed (attempt ${attempt}/${MAX_RETRIES}), retrying...`,
          );
          continue;
        }
        await this.sendAgentMessage(
          ctx,
          '❌ Could not connect to the LLM. Please check the Issue Compiler provider configuration in Settings.',
        );
        await this.markFailed(ctx, 'LLM call failed');
        return null;
      }

      // Parse completion
      if (!result.content.includes(COMPLETION_MARKER)) {
        this.logger.warn(
          'LLM response missing completion marker, attempting JSON extraction',
        );
      }

      try {
        return parseCompilationJson(result.content);
      } catch (err) {
        this.logger.error(
          `Failed to parse compilation result (attempt ${attempt}/${MAX_RETRIES}): ${err.message}`,
        );
        this.logger.debug(
          `LLM response (first 500 chars): ${result.content.substring(0, 500)}`,
        );
        if (attempt < MAX_RETRIES) {
          await this.sendAgentMessage(
            ctx,
            `⚠️ JSON parse failed (attempt ${attempt}/${MAX_RETRIES}), retrying...`,
          );
          messages.push(
            { role: 'assistant', content: result.content.substring(0, 200) },
            {
              role: 'user',
              content:
                'Your response was not valid JSON. Please respond with ONLY the JSON object (no prose, no explanation). Start with { and end with }. Use the exact format from the instructions.',
            },
          );
          continue;
        }
        await this.sendAgentMessage(
          ctx,
          `❌ Failed to parse LLM response after ${MAX_RETRIES} attempts.`,
        );
        await this.markFailed(ctx, `JSON parse failed: ${err.message}`);
        return null;
      }
    }
    return null;
  }

  // ─── Step 4: Create Milestones + Issues + Tasks ──────────────

  private async createMilestonesAndIssues(
    ctx: AgentContext,
    projectData: {
      project: { id: string };
      gitlabProjectId: number | null;
      gitlabProjectPath: string | null;
      chatSessionId?: string;
    },
    compiledResult: IssueCompilerResult,
  ): Promise<void> {
    const { project, gitlabProjectId, gitlabProjectPath, chatSessionId } =
      projectData;
    let createdIssues = 0;
    let createdTasks = 0;
    let failedTasks = 0;

    for (let msIdx = 0; msIdx < compiledResult.milestones.length; msIdx++) {
      const milestone = compiledResult.milestones[msIdx];

      // Create GitLab milestone
      let gitlabMilestoneId: number | undefined;
      if (gitlabProjectId) {
        try {
          const glMilestone = await this.gitlabService.createMilestone(
            gitlabProjectId,
            {
              title: milestone.title,
              description: milestone.description,
            },
          );
          gitlabMilestoneId = glMilestone.id;
        } catch (err) {
          this.logger.warn(
            `GitLab milestone creation failed for "${milestone.title}": ${err.message}`,
          );
          await this.log(
            ctx.agentTaskId,
            'WARN',
            `GitLab milestone failed: ${milestone.title}`,
            { error: err.message },
          );
        }
      }

      // Create DB milestone
      let dbMilestoneId: string | undefined;
      try {
        const dbMilestone = await this.prisma.milestone.create({
          data: {
            projectId: project.id,
            title: milestone.title,
            description: milestone.description,
            sortOrder: msIdx,
            gitlabMilestoneId: gitlabMilestoneId ?? null,
          },
        });
        dbMilestoneId = dbMilestone.id;
      } catch (err) {
        this.logger.warn(
          `DB milestone creation failed for "${milestone.title}": ${err.message}`,
        );
        await this.log(
          ctx.agentTaskId,
          'WARN',
          `DB milestone failed: ${milestone.title}`,
          { error: err.message },
        );
      }

      await this.sendAgentMessage(ctx, `🏁 Milestone: **${milestone.title}**`);

      // Create issues within this milestone
      for (let issueIdx = 0; issueIdx < milestone.issues.length; issueIdx++) {
        const compiledIssue = milestone.issues[issueIdx];
        try {
          // Deduplication
          const existing = await this.prisma.issue.findFirst({
            where: { projectId: project.id, title: compiledIssue.title },
          });
          if (existing) {
            await this.log(
              ctx.agentTaskId,
              'INFO',
              `Skipped duplicate issue: ${compiledIssue.title}`,
              { existingIssueId: existing.id },
            );
            continue;
          }

          const issue = await this.issuesService.create({
            projectId: project.id,
            title: compiledIssue.title,
            description: compiledIssue.description,
            priority: this.mapPriority(compiledIssue.priority),
            labels: compiledIssue.labels,
            milestoneId: dbMilestoneId,
            gitlabMilestoneId: gitlabMilestoneId,
            sortOrder: issueIdx,
            chatSessionId,
            syncToGitlab: true,
          });

          createdIssues++;
          await this.log(
            ctx.agentTaskId,
            'INFO',
            `Created issue: ${compiledIssue.title}`,
            {
              issueId: issue.id,
              gitlabIid: issue.gitlabIid,
              milestone: milestone.title,
            },
          );

          // Create tasks as children
          for (const task of compiledIssue.tasks) {
            try {
              const subIssue = await this.issuesService.create({
                projectId: project.id,
                title: task.title,
                description: task.description,
                priority: this.mapPriority(compiledIssue.priority),
                labels: compiledIssue.labels,
                parentId: issue.id,
                syncToGitlab: false,
              });

              if (gitlabProjectPath && issue.gitlabIid && gitlabProjectId) {
                try {
                  const parentWorkItemId =
                    await this.gitlabService.getWorkItemId(
                      gitlabProjectPath,
                      issue.gitlabIid,
                    );

                  const workItem = await this.gitlabService.createTask(
                    gitlabProjectPath,
                    parentWorkItemId,
                    { title: task.title, description: task.description },
                  );

                  const workItemIid = parseInt(workItem.iid, 10);
                  if (!isNaN(workItemIid)) {
                    await this.prisma.issue.update({
                      where: { id: subIssue.id },
                      data: { gitlabIid: workItemIid },
                    });
                  }
                } catch (glErr) {
                  this.logger.warn(
                    `GitLab task creation failed for "${task.title}": ${glErr.message}`,
                  );
                  await this.log(
                    ctx.agentTaskId,
                    'WARN',
                    `GitLab task failed: ${task.title}`,
                    { error: glErr.message },
                  );
                  failedTasks++;
                }
              }

              createdTasks++;
            } catch (taskErr) {
              this.logger.warn(
                `Task creation failed for "${task.title}": ${taskErr.message}`,
              );
              failedTasks++;
            }
          }

          // Progress update every few issues
          if (
            createdIssues % 3 === 0 ||
            createdIssues === compiledResult.totalIssues
          ) {
            await this.sendAgentMessage(
              ctx,
              `📝 Progress: ${createdIssues}/${compiledResult.totalIssues} issues created (${createdTasks} tasks)...`,
            );
          }
        } catch (issueErr) {
          this.logger.error(
            `Issue creation failed for "${compiledIssue.title}": ${issueErr.message}`,
          );
          await this.log(
            ctx.agentTaskId,
            'ERROR',
            `Issue creation failed: ${compiledIssue.title}`,
            { error: issueErr.message },
          );
        }
      }
    }

    await this.log(ctx.agentTaskId, 'INFO', 'Issue creation complete', {
      createdIssues,
      createdTasks,
      failedTasks,
    });
  }

  // ─── Step 5: Finalize ───────────────────────────────────────

  private async finalize(
    ctx: AgentContext,
    result: IssueCompilerResult,
  ): Promise<void> {
    await this.prisma.agentTask.update({
      where: { id: ctx.agentTaskId },
      data: {
        status: AgentTaskStatus.COMPLETED,
        output: sanitizeJsonOutput(result) as any,
        completedAt: new Date(),
      },
    });

    const summaryLines: string[] = [
      `✅ **Issue Compilation complete!**`,
      ``,
      `Created **${result.totalMilestones} milestones** with **${result.totalIssues} issues** and **${result.totalTasks} tasks** total.`,
    ];

    for (const milestone of result.milestones) {
      summaryLines.push('');
      summaryLines.push(`### 🏁 ${milestone.title}`);
      if (milestone.description) {
        summaryLines.push(`_${milestone.description}_`);
      }
      summaryLines.push('');
      summaryLines.push(`| # | Issue | Priority | Tasks |`);
      summaryLines.push(`|---|-------|----------|-------|`);
      milestone.issues.forEach((issue, i) => {
        summaryLines.push(
          `| ${i + 1} | ${issue.title} | ${issue.priority} | ${issue.tasks.length} |`,
        );
      });
    }

    summaryLines.push('');
    summaryLines.push(
      'Issues are synced to GitLab with milestones and parent-child task hierarchy.',
    );

    await this.sendAgentMessage(ctx, summaryLines.join('\n'));
    await this.updateStatus(ctx, AgentStatus.IDLE);
    await this.log(ctx.agentTaskId, 'INFO', 'Issue compilation completed', {
      totalMilestones: result.totalMilestones,
      totalIssues: result.totalIssues,
      totalTasks: result.totalTasks,
    });

    // Trigger Coder Agent
    this.eventEmitter.emit('agent.issueCompilerComplete', {
      projectId: ctx.projectId,
      chatSessionId: ctx.chatSessionId,
    });
  }

  // ─── Helpers ────────────────────────────────────────────────

  /** Map our priority strings to Prisma IssuePriority enum */
  private mapPriority(priority: string): IssuePriority {
    switch (priority.toUpperCase()) {
      case 'LOW':
        return IssuePriority.LOW;
      case 'MEDIUM':
        return IssuePriority.MEDIUM;
      case 'HIGH':
        return IssuePriority.HIGH;
      case 'CRITICAL':
        return IssuePriority.CRITICAL;
      default:
        return IssuePriority.MEDIUM;
    }
  }

  /** Mark the task as failed and update agent status */
  private async markFailed(ctx: AgentContext, reason: string): Promise<void> {
    try {
      await this.prisma.agentTask.update({
        where: { id: ctx.agentTaskId },
        data: {
          status: AgentTaskStatus.FAILED,
          completedAt: new Date(),
        },
      });

      await this.updateStatus(ctx, AgentStatus.ERROR);
      await this.log(ctx.agentTaskId, 'ERROR', `Compilation failed: ${reason}`);
    } catch (err) {
      this.logger.error(`Failed to mark task as failed: ${err.message}`);
    }
  }
}
