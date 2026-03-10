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
import { MonitorGateway } from '../../monitor/monitor.gateway';
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
4. **Architect Agent** → Will analyze code structure and ground issues with technical context
5. **Coder Agent** → Will implement these issues based on YOUR descriptions

Your job is to take the feature list from the interview and create **detailed, high-quality** issues with concrete sub-tasks, grouped into logical milestones. The Coder Agent relies ENTIRELY on your descriptions to implement features correctly — vague or thin descriptions lead to wrong implementations.

## Input You Receive
- Project name and description
- Tech stack (framework, language, backend, database)
- Feature list from the interview

## Output Rules

### Milestones (Development Phases)
- Group issues into 2-5 milestones representing logical development phases
- Milestone titles follow the pattern: "v0.1 — Setup & Foundation", "v0.2 — Core Features", etc.
- Each milestone has a description (2-3 sentences) explaining the phase goal and what should be working by the end
- Order milestones logically: setup → core → secondary → polish

### Issues — QUALITY IS CRITICAL
Each issue is a self-contained work package that a Coder Agent can implement without guessing.

**Title**: Clear, imperative, specific ("Implement JWT authentication with refresh tokens", "Create responsive Kanban board with drag-and-drop")

**Description** (MANDATORY structure, use Markdown):
Each issue description MUST contain ALL of these sections:

\`\`\`
## Overview
What needs to be built and why (2-3 sentences). Explain the user-facing value and how it fits into the overall application.

## Requirements
- Bullet list of specific, testable requirements
- Each requirement should be concrete enough to verify ("User can filter by date range" not "Add filtering")
- Include both functional requirements AND edge cases

## Technical Notes
- Suggested approach, components, services, endpoints, or data models
- Name specific files, classes, or patterns where applicable
- Mention relevant dependencies or integrations with other features

## Acceptance Criteria
- [ ] Criterion 1 — a specific, verifiable condition
- [ ] Criterion 2 — another testable outcome
- [ ] Criterion 3 — include error/edge cases
\`\`\`

**Minimum quality bar**: Each issue description MUST be at least 400 characters. Descriptions under 400 characters are UNACCEPTABLE and will cause implementation failures.

**Labels**: Based on content — use these: \`frontend\`, \`backend\`, \`setup\`, \`testing\`, \`styling\`, \`database\`, \`api\`, \`auth\`, \`docs\`, \`devops\`
**Priority**: Setup/infrastructure = HIGH, Core features = HIGH, Nice-to-have = MEDIUM, Polish = LOW

### Tasks (Sub-Items per Issue)
- Each issue has 2-6 concrete tasks
- Tasks are actionable development steps a coder can pick up individually
- **Task title**: Specific action — "Create TodoService with CRUD methods and Prisma queries" not "Create service"
- **Task description**: 2-4 sentences explaining exactly what to implement, which files to create or modify, and what the expected behavior is. Include relevant details like API routes, component names, validation rules, or data flow.

### Quality Guidelines
- Write in English (code convention)
- Be SPECIFIC — "Create LoginComponent with email/password form, validation errors, loading state, and redirect to /dashboard on success" not "Create login page"
- Think from the Coder's perspective: Could someone implement this WITHOUT asking follow-up questions?
- Include setup tasks (project init, routing, DB schema, config) in the first milestone
- Order issues logically within each milestone (dependencies first)
- If a feature depends on another issue, mention it in Technical Notes
- Consider error states, empty states, loading states, and edge cases

## Completion Format
When done, end your message with exactly this format:

${COMPLETION_MARKER}
\`\`\`json
{
  "milestones": [
    {
      "title": "v0.1 — Setup & Foundation",
      "description": "Initialize the project structure, set up the database schema, and implement the basic application shell. By the end of this phase, the project builds, connects to the database, and renders a basic layout.",
      "issues": [
        {
          "title": "Initialize project and database schema",
          "description": "## Overview\\nSet up the monorepo workspace with Angular frontend and NestJS backend, define the initial Prisma schema for all core data models, and run migrations against PostgreSQL. This establishes the technical foundation that every subsequent issue builds upon.\\n\\n## Requirements\\n- Project structure with shared TypeScript config\\n- Prisma schema with Todo, Category, Tag models and correct relations (many-to-many for Tags)\\n- Database migrations applied and Prisma Client generated\\n- Both frontend and backend dev servers start without errors\\n\\n## Technical Notes\\n- Use \`npx prisma init\` for schema setup, then define models manually\\n- Todo model needs: id, title, description, status (enum: OPEN/IN_PROGRESS/DONE), priority (enum), dueDate, createdAt, updatedAt\\n- Category: id, name, color (hex string)\\n- Tag: id, name with implicit many-to-many via _TagToTodo\\n\\n## Acceptance Criteria\\n- [ ] \`npm run dev\` starts both frontend (:4200) and backend (:3100) without errors\\n- [ ] Prisma Studio shows all tables with correct columns and relations\\n- [ ] At least one seed record per table verifies the schema works end-to-end",
          "priority": "HIGH",
          "labels": ["setup", "database", "devops"],
          "tasks": [
            {
              "title": "Scaffold Angular + NestJS workspace",
              "description": "Create the Angular 19 frontend with standalone components and Tailwind CSS, and the NestJS backend with Prisma module. Configure shared tsconfig paths and add a root package.json with scripts to run both dev servers concurrently."
            },
            {
              "title": "Define Prisma schema with all core models",
              "description": "Create the Prisma schema in backend/prisma/schema.prisma with Todo, Category, and Tag models. Todo has fields: id (cuid), title (string), description (string?), status (enum TodoStatus), priority (enum Priority), dueDate (DateTime?), categoryId (relation), and timestamps. Tags use an implicit many-to-many relation. Add appropriate indexes on status and dueDate."
            },
            {
              "title": "Run migrations and generate client",
              "description": "Execute prisma migrate dev to create the initial migration. Generate the Prisma client and create a seed script (prisma/seed.ts) that inserts 2 categories, 3 tags, and 5 sample todos with various statuses for development testing."
            }
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
- Every issue description MUST be at least 400 characters with Overview, Requirements, Technical Notes, and Acceptance Criteria sections
- Every task description MUST be at least 2 sentences (minimum 100 characters)
- Priority must be one of: LOW, MEDIUM, HIGH, CRITICAL
- Labels must be lowercase strings
- Do NOT wrap the JSON in thinking tags or any other wrapper
- Use \\n for newlines inside JSON strings, NOT actual newlines`;

/** Completion instructions appended to ALL system prompts (custom or default) */
const ISSUE_COMPLETION_INSTRUCTIONS = `

## MANDATORY Quality Standards (ALWAYS follow these)

### Issue Descriptions — MINIMUM REQUIREMENTS
Every issue description MUST use this Markdown structure:
- **Overview** (2-3 sentences): What and why
- **Requirements** (bullet list): Specific, testable requirements including edge cases
- **Technical Notes** (bullet list): Suggested approach, components, files, endpoints, data models
- **Acceptance Criteria** (checkbox list): Verifiable conditions for "done"

Minimum 400 characters per issue description. The Coder Agent implements ONLY what you describe — omissions become bugs.

### Task Descriptions — MINIMUM REQUIREMENTS
Every task description MUST be 2-4 sentences (minimum 100 characters) explaining exactly what to implement, which files to touch, and what the expected behavior is.

## MANDATORY Completion Format (ALWAYS follow this)
When done compiling issues, end your message with EXACTLY this format.
The marker line and JSON block MUST appear — without them the system cannot proceed.

${COMPLETION_MARKER}
\`\`\`json
{
  "milestones": [
    {
      "title": "v0.1 — Phase Name",
      "description": "What this phase achieves and what should be working by the end (2-3 sentences).",
      "issues": [
        {
          "title": "Specific imperative issue title",
          "description": "## Overview\\nWhat needs to be built and why (2-3 sentences).\\n\\n## Requirements\\n- Specific testable requirement 1\\n- Specific testable requirement 2\\n- Edge case handling\\n\\n## Technical Notes\\n- Suggested component/service/endpoint names\\n- Data model details\\n- Integration points with other features\\n\\n## Acceptance Criteria\\n- [ ] Verifiable condition 1\\n- [ ] Verifiable condition 2\\n- [ ] Error/edge case handled",
          "priority": "HIGH",
          "labels": ["frontend", "setup"],
          "tasks": [
            {
              "title": "Specific task title with context",
              "description": "2-4 sentences explaining what to implement. Name the files, components, or services to create. Describe the expected inputs, outputs, and behavior including error handling."
            }
          ]
        }
      ]
    }
  ]
}
\`\`\`

CRITICAL RULES:
- The JSON must be valid and parseable
- Every issue description MUST be at least 400 characters with all 4 sections (Overview, Requirements, Technical Notes, Acceptance Criteria)
- Every task description MUST be at least 100 characters (2+ sentences)
- Group ALL issues into milestones — do not return a flat "issues" array at the top level
- Use \\n for newlines inside JSON strings
- Do NOT include thinking tags, comments, or trailing commas in the JSON`;

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
    super(prisma, settings, chatService, chatGateway, llmService, monitorGateway);
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
      .map((f, i) => {
        if (typeof f === 'string') return `${i + 1}. ${f}`;
        // Rich feature object from interview
        const parts = [`${i + 1}. **${f.title}** [${f.priority ?? 'medium'}]`];
        if (f.description) parts.push(`   ${f.description}`);
        if (f.acceptanceCriteria?.length) {
          parts.push(`   Acceptance Criteria: ${f.acceptanceCriteria.join('; ')}`);
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

      // Strip Markdown code fences (```json ... ``` or ``` ... ```)
      const codeFenceMatch = jsonPart.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
      if (codeFenceMatch) {
        jsonPart = codeFenceMatch[1].trim();
      }

      // Try to find the outermost JSON object containing "milestones" or "issues"
      const jsonMatch = jsonPart.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON object found in LLM response');
      }

      // Clean common JSON issues from local LLMs
      let jsonStr = jsonMatch[0];
      // Remove trailing commas before } or ]
      jsonStr = jsonStr.replace(/,\s*([}\]])/g, '$1');

      // Try parsing as-is first
      try {
        return JSON.parse(jsonStr);
      } catch (firstErr) {
        // Attempt bracket-balanced extraction from the beginning
        this.logger.warn(`First JSON parse failed (${firstErr.message}), trying bracket-balanced extraction`);
        const balanced = this.extractBalancedJson(jsonStr);
        if (balanced) {
          const cleaned = balanced.replace(/,\s*([}\]])/g, '$1');
          return JSON.parse(cleaned);
        }
        throw firstErr;
      }
    } catch (err) {
      this.logger.error(`Failed to parse compilation result: ${err.message}`);
      this.logger.debug(`LLM response (first 500 chars): ${result.content.substring(0, 500)}`);
      await this.sendAgentMessage(
        ctx,
        `❌ Failed to parse LLM response. The Issue Compiler will retry or the issues can be created manually.`,
      );
      await this.markFailed(ctx, `JSON parse failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Extract a balanced JSON object from a string by counting brackets.
   * Handles cases where LLM adds text after the JSON.
   */
  private extractBalancedJson(str: string): string | null {
    const start = str.indexOf('{');
    if (start === -1) return null;

    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = start; i < str.length; i++) {
      const ch = str[i];

      if (escape) {
        escape = false;
        continue;
      }

      if (ch === '\\' && inString) {
        escape = true;
        continue;
      }

      if (ch === '"') {
        inString = !inString;
        continue;
      }

      if (inString) continue;

      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          return str.substring(start, i + 1);
        }
      }
    }

    return null;
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

      // Create issues within this milestone (order matters for sequential pipeline!)
      for (let issueIdx = 0; issueIdx < milestone.issues.length; issueIdx++) {
        const compiledIssue = milestone.issues[issueIdx];
        try {
          // Deduplication: skip if issue with same title already exists in this project
          const existing = await this.prisma.issue.findFirst({
            where: { projectId: project.id, title: compiledIssue.title },
          });
          if (existing) {
            await this.log(ctx.agentTaskId, 'INFO', `Skipped duplicate issue: ${compiledIssue.title}`, {
              existingIssueId: existing.id,
            });
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
