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
import { BaseAgent, AgentContext } from '../agent-base';
import { InterviewResult } from '../interviewer/interview-result.interface';
import {
  CompiledIssue,
  CompiledMilestone,
  CompiledTask,
  IssueCompilerResult,
} from './issue-compiler-result.interface';
import {
  AgentRole,
  AgentStatus,
  AgentTaskStatus,
  IssuePriority,
} from '@prisma/client';

/** Marker the LLM emits when compilation is done */
const COMPLETION_MARKER = ':::ISSUES_COMPILED:::';

const DEFAULT_SYSTEM_PROMPT = `You are the Issue Compiler Agent for VibCode Hub — an AI development team platform.

## Your Role in the Pipeline
You are the THIRD agent in a chain:
1. **Interviewer** → Gathered project requirements & features
2. **DevOps Agent** → Set up the repository & tooling
3. **YOU (Issue Compiler)** → Break features into actionable GitLab Issues + Tasks grouped by Milestones
4. **Coder Agent** → Will implement these issues (later)

Your job is to take the feature list from the interview and create well-structured, actionable issues with concrete sub-tasks, **grouped into logical milestones** (development phases).

## Input You Receive
- Project name and description
- Tech stack (framework, language, backend, database)
- Feature list from the interview

## Output Rules

### Milestones (Development Phases)
- Group issues into 2-5 milestones representing logical development phases
- Milestone titles follow the pattern: "v0.1 — Setup & Foundation", "v0.2 — Core Features", etc.
- Each milestone has a short description (1-2 sentences) explaining the phase goal
- Order milestones logically: setup → core → secondary → polish

### Issues
- Each feature becomes 1 issue (sometimes a feature can be split into 2 if it's large)
- Issue title: Clear, imperative ("Implement user authentication", "Create dashboard layout")
- Issue description: 2-4 sentences explaining WHAT needs to be built and WHY
- Labels: Based on content — use these: \`frontend\`, \`backend\`, \`setup\`, \`testing\`, \`styling\`, \`database\`, \`api\`, \`auth\`, \`docs\`
- Priority: Setup/infrastructure = HIGH, Core features = HIGH, Nice-to-have = MEDIUM, Polish = LOW

### Tasks (Sub-Items per Issue)
- Each issue has 2-6 concrete tasks
- Tasks are actionable development steps: "Create UserService with login/register methods", "Add Tailwind dark theme configuration"
- Task description: 1-2 sentences explaining what to do concretely
- Think in terms of: Component, Service, Module, Test, Configuration, Styling

### Important
- Write in English (code convention)
- Be specific — "Create LoginComponent with email/password form" not "Create login"
- Include setup tasks (project config, routing, etc.) in the first milestone
- Order issues logically within each milestone

## Completion Format
When done, end your message with exactly this format:

${COMPLETION_MARKER}
\`\`\`json
{
  "milestones": [
    {
      "title": "v0.1 — Setup & Foundation",
      "description": "Initial project setup and configuration",
      "issues": [
        {
          "title": "Issue title",
          "description": "What needs to be built and why",
          "priority": "HIGH",
          "labels": ["frontend", "setup"],
          "tasks": [
            { "title": "Task title", "description": "What to do" },
            { "title": "Another task", "description": "What to do" }
          ]
        }
      ]
    }
  ]
}
\`\`\`

CRITICAL RULES:
- The line ${COMPLETION_MARKER} must appear EXACTLY as shown
- The JSON must be valid and parseable
- Every issue MUST have at least 2 tasks
- Priority must be one of: LOW, MEDIUM, HIGH, CRITICAL
- Labels must be lowercase strings
- Do NOT wrap the JSON in thinking tags or any other wrapper`;

/** Completion instructions appended to ALL system prompts (custom or default) */
const ISSUE_COMPLETION_INSTRUCTIONS = `

## MANDATORY Completion Format (ALWAYS follow this)
When done compiling issues, end your message with EXACTLY this format.
The marker line and JSON block MUST appear — without them the system cannot proceed.

${COMPLETION_MARKER}
\`\`\`json
{
  "milestones": [
    {
      "title": "v0.1 — Phase Name",
      "description": "What this phase achieves",
      "issues": [
        {
          "title": "Issue title",
          "description": "What needs to be built and why",
          "priority": "HIGH",
          "labels": ["frontend", "setup"],
          "tasks": [
            { "title": "Task title", "description": "What to do" }
          ]
        }
      ]
    }
  ]
}
\`\`\`

CRITICAL: The JSON must be valid. Do NOT include thinking tags, comments, or trailing commas in the JSON.
Group ALL issues into milestones — do not return a flat "issues" array at the top level.`;

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
    private readonly eventEmitter: EventEmitter2,
  ) {
    super(prisma, settings, chatService, chatGateway, llmService);
  }

  /** Run the full issue compilation pipeline */
  async runCompilation(ctx: AgentContext): Promise<void> {
    try {
      await this.updateStatus(ctx, AgentStatus.WORKING);
      await this.sendAgentMessage(ctx, '📋 **Issue Compiler** starting — analyzing features and creating issues...');

      // Step 1: Load project data
      const projectData = await this.loadProjectData(ctx);
      if (!projectData) return; // Fatal — already handled

      // Step 2: Call LLM to compile issues
      const rawResult = await this.callLlmForCompilation(ctx, projectData);
      if (!rawResult) return; // Fatal — already handled

      // Step 3: Normalize result
      const compiledResult = this.normalizeResult(rawResult);

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

      const interviewResult = project.techStack as unknown as InterviewResult;
      if (!interviewResult?.features?.length) {
        throw new Error('No features found in interview result');
      }

      let gitlabProjectPath: string | null = null;
      if (project.gitlabProjectId) {
        try {
          const glProject = await this.gitlabService.getProject(project.gitlabProjectId);
          gitlabProjectPath = glProject.path_with_namespace;
        } catch (err) {
          this.logger.warn(`Could not load GitLab project: ${err.message}`);
        }
      }

      await this.log(ctx.agentTaskId, 'INFO', 'Project data loaded', {
        features: interviewResult.features.length,
        hasGitlab: !!gitlabProjectPath,
      });

      return {
        project,
        interviewResult,
        gitlabProjectId: project.gitlabProjectId,
        gitlabProjectPath,
      };
    } catch (err) {
      await this.sendAgentMessage(ctx, `❌ Failed to load project data: ${err.message}`);
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
      .map((f, i) => `${i + 1}. ${f}`)
      .join('\n');

    const techInfo = [
      `Framework: ${interviewResult.techStack?.framework ?? 'N/A'}`,
      `Language: ${interviewResult.techStack?.language ?? 'N/A'}`,
      `Backend: ${interviewResult.techStack?.backend ?? 'none'}`,
      `Database: ${interviewResult.techStack?.database ?? 'none'}`,
      interviewResult.techStack?.additional?.length
        ? `Additional: ${interviewResult.techStack.additional.join(', ')}`
        : null,
    ].filter(Boolean).join('\n');

    const userPrompt = `Please compile the following project features into structured GitLab issues with sub-tasks, grouped into milestones (development phases).

**Project:** ${project.name}
**Description:** ${project.description || interviewResult.description || 'N/A'}

**Tech Stack:**
${techInfo}

**Features to compile:**
${featureList}

Create well-structured milestones with issues and actionable tasks. Group logically: setup/config first, then core features, then polish/extras.`;

    const messages: LlmMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];

    await this.sendAgentMessage(ctx, `🤖 Analyzing ${interviewResult.features.length} features...`);

    const result = await this.callLlm(messages);

    if (result.finishReason === 'error') {
      await this.sendAgentMessage(
        ctx,
        '❌ Could not connect to the LLM. Please check the Issue Compiler provider configuration in Settings.',
      );
      await this.markFailed(ctx, 'LLM call failed');
      return null;
    }

    // Parse completion
    if (!result.content.includes(COMPLETION_MARKER)) {
      // LLM didn't use the marker — try to extract JSON anyway
      this.logger.warn('LLM response missing completion marker, attempting JSON extraction');
    }

    try {
      let jsonPart = result.content.includes(COMPLETION_MARKER)
        ? result.content.substring(result.content.indexOf(COMPLETION_MARKER) + COMPLETION_MARKER.length)
        : result.content;

      // Strip thinking tags that local LLMs (qwen3.5) often wrap around output
      jsonPart = jsonPart.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

      const jsonMatch = jsonPart.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON object found in LLM response');
      }

      // Clean common JSON issues from local LLMs
      let jsonStr = jsonMatch[0];
      // Remove trailing commas before } or ]
      jsonStr = jsonStr.replace(/,\s*([}\]])/g, '$1');

      return JSON.parse(jsonStr);
    } catch (err) {
      this.logger.error(`Failed to parse compilation result: ${err.message}`);
      await this.sendAgentMessage(
        ctx,
        `❌ Failed to parse LLM response. The Issue Compiler will retry or the issues can be created manually.`,
      );
      await this.markFailed(ctx, `JSON parse failed: ${err.message}`);
      return null;
    }
  }

  // ─── Step 3: Normalize ──────────────────────────────────────

  private normalizeResult(raw: Record<string, any>): IssueCompilerResult {
    // Helper: find a value by trying multiple key variants
    const pick = (...keys: string[]): any => {
      for (const k of keys) {
        if (raw[k] !== undefined) return raw[k];
      }
      return undefined;
    };

    // Try to extract milestones
    let rawMilestones: any[] | undefined = pick('milestones', 'phases', 'versions', 'sprints');

    let milestones: CompiledMilestone[];

    if (Array.isArray(rawMilestones) && rawMilestones.length > 0) {
      // LLM returned milestone-grouped output
      milestones = rawMilestones.map((m: any, i: number) => ({
        title: m.title ?? m.name ?? `v0.${i + 1} — Phase ${i + 1}`,
        description: m.description ?? m.summary ?? '',
        issues: this.normalizeIssues(m.issues ?? m.items ?? m.tickets ?? []),
      }));
    } else {
      // Fallback: flat issues list → wrap in single milestone
      const flatIssues = pick('issues', 'items', 'tickets', 'compiled_issues') ?? [];
      milestones = [{
        title: 'v0.1 — MVP',
        description: 'All project issues',
        issues: this.normalizeIssues(flatIssues),
      }];
    }

    // Build flat issues array from milestones
    const allIssues = milestones.flatMap(m => m.issues);
    const totalTasks = allIssues.reduce((sum, i) => sum + i.tasks.length, 0);

    this.logger.debug(
      `Normalized: ${milestones.length} milestones, ${allIssues.length} issues, ${totalTasks} tasks`,
    );

    return {
      milestones,
      issues: allIssues,
      totalMilestones: milestones.length,
      totalIssues: allIssues.length,
      totalTasks,
    };
  }

  /** Normalize a raw issues array from LLM output */
  private normalizeIssues(rawIssues: any[]): CompiledIssue[] {
    return rawIssues.map((raw: any) => {
      const title = raw.title ?? raw.name ?? raw.summary ?? 'Untitled Issue';
      const description = raw.description ?? raw.body ?? raw.details ?? '';

      // Normalize priority
      let priority = (raw.priority ?? raw.severity ?? 'MEDIUM').toUpperCase();
      if (!['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(priority)) {
        priority = 'MEDIUM';
      }

      // Normalize labels
      let labels = raw.labels ?? raw.tags ?? [];
      if (typeof labels === 'string') {
        labels = labels.split(',').map((l: string) => l.trim().toLowerCase());
      }
      labels = labels.map((l: string) => l.toLowerCase());

      // Normalize tasks
      let tasks: CompiledTask[] = (raw.tasks ?? raw.subtasks ?? raw.sub_tasks ?? raw.children ?? [])
        .map((t: any) => ({
          title: t.title ?? t.name ?? t.summary ?? 'Untitled Task',
          description: t.description ?? t.body ?? t.details ?? '',
        }));

      // Ensure at least 2 tasks
      if (tasks.length < 2) {
        tasks.push({ title: `Implement ${title}`, description: 'Core implementation' });
        if (tasks.length < 2) {
          tasks.push({ title: `Test ${title}`, description: 'Write tests and verify' });
        }
      }

      return { title, description, priority: priority as CompiledIssue['priority'], labels, tasks };
    });
  }

  // ─── Step 4: Create Milestones + Issues + Tasks ──────────────

  private async createMilestonesAndIssues(
    ctx: AgentContext,
    projectData: {
      project: { id: string };
      gitlabProjectId: number | null;
      gitlabProjectPath: string | null;
    },
    compiledResult: IssueCompilerResult,
  ): Promise<void> {
    const { project, gitlabProjectId, gitlabProjectPath } = projectData;
    let createdIssues = 0;
    let createdTasks = 0;
    let failedTasks = 0;

    for (let msIdx = 0; msIdx < compiledResult.milestones.length; msIdx++) {
      const milestone = compiledResult.milestones[msIdx];

      // Create GitLab milestone
      let gitlabMilestoneId: number | undefined;
      if (gitlabProjectId) {
        try {
          const glMilestone = await this.gitlabService.createMilestone(gitlabProjectId, {
            title: milestone.title,
            description: milestone.description,
          });
          gitlabMilestoneId = glMilestone.id;
        } catch (err) {
          this.logger.warn(`GitLab milestone creation failed for "${milestone.title}": ${err.message}`);
          await this.log(ctx.agentTaskId, 'WARN', `GitLab milestone failed: ${milestone.title}`, {
            error: err.message,
          });
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
        this.logger.warn(`DB milestone creation failed for "${milestone.title}": ${err.message}`);
        await this.log(ctx.agentTaskId, 'WARN', `DB milestone failed: ${milestone.title}`, {
          error: err.message,
        });
      }

      await this.sendAgentMessage(ctx, `🏁 Milestone: **${milestone.title}**`);

      // Create issues within this milestone
      for (const compiledIssue of milestone.issues) {
        try {
          const issue = await this.issuesService.create({
            projectId: project.id,
            title: compiledIssue.title,
            description: compiledIssue.description,
            priority: this.mapPriority(compiledIssue.priority),
            labels: compiledIssue.labels,
            milestoneId: dbMilestoneId,
            gitlabMilestoneId: gitlabMilestoneId,
            syncToGitlab: true,
          });

          createdIssues++;
          await this.log(ctx.agentTaskId, 'INFO', `Created issue: ${compiledIssue.title}`, {
            issueId: issue.id,
            gitlabIid: issue.gitlabIid,
            milestone: milestone.title,
          });

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
                syncToGitlab: false, // We'll create as WorkItem Task instead
              });

              // Create as GitLab Task (child of issue) if GitLab is available
              if (gitlabProjectPath && issue.gitlabIid && gitlabProjectId) {
                try {
                  const parentWorkItemId = await this.gitlabService.getWorkItemId(
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
                  this.logger.warn(`GitLab task creation failed for "${task.title}": ${glErr.message}`);
                  await this.log(ctx.agentTaskId, 'WARN', `GitLab task failed: ${task.title}`, {
                    error: glErr.message,
                  });
                  failedTasks++;
                }
              }

              createdTasks++;
            } catch (taskErr) {
              this.logger.warn(`Task creation failed for "${task.title}": ${taskErr.message}`);
              failedTasks++;
            }
          }

          // Progress update every few issues
          if (createdIssues % 3 === 0 || createdIssues === compiledResult.totalIssues) {
            await this.sendAgentMessage(
              ctx,
              `📝 Progress: ${createdIssues}/${compiledResult.totalIssues} issues created (${createdTasks} tasks)...`,
            );
          }

        } catch (issueErr) {
          this.logger.error(`Issue creation failed for "${compiledIssue.title}": ${issueErr.message}`);
          await this.log(ctx.agentTaskId, 'ERROR', `Issue creation failed: ${compiledIssue.title}`, {
            error: issueErr.message,
          });
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

  private async finalize(ctx: AgentContext, result: IssueCompilerResult): Promise<void> {
    await this.prisma.agentTask.update({
      where: { id: ctx.agentTaskId },
      data: {
        status: AgentTaskStatus.COMPLETED,
        output: result as any,
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
        summaryLines.push(`| ${i + 1} | ${issue.title} | ${issue.priority} | ${issue.tasks.length} |`);
      });
    }

    summaryLines.push('');
    summaryLines.push('Issues are synced to GitLab with milestones and parent-child task hierarchy.');

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
      case 'LOW': return IssuePriority.LOW;
      case 'MEDIUM': return IssuePriority.MEDIUM;
      case 'HIGH': return IssuePriority.HIGH;
      case 'CRITICAL': return IssuePriority.CRITICAL;
      default: return IssuePriority.MEDIUM;
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
