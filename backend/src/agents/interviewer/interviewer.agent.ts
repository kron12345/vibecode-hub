import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import { SystemSettingsService } from '../../settings/system-settings.service';
import { ChatService } from '../../chat/chat.service';
import { ChatGateway } from '../../chat/chat.gateway';
import { LlmService } from '../../llm/llm.service';
import { LlmMessage } from '../../llm/llm.interfaces';
import { PreviewService } from '../../preview/preview.service';
import { MonitorGateway } from '../../monitor/monitor.gateway';
import { BaseAgent, AgentContext } from '../agent-base';
import { InterviewResult, FeatureInterviewResult, InterviewProgress } from './interview-result.interface';
import {
  AgentRole,
  AgentStatus,
  AgentTaskStatus,
  ProjectStatus,
} from '@prisma/client';

/** Marker the LLM emits when the interview is complete */
const COMPLETION_MARKER = ':::INTERVIEW_COMPLETE:::';
/** Marker the LLM emits when the feature interview is complete */
const FEATURE_COMPLETION_MARKER = ':::FEATURE_INTERVIEW_COMPLETE:::';
/** Marker for clickable suggestion chips */
const SUGGESTIONS_MARKER = ':::SUGGESTIONS:::';
/** Marker for partial interview progress */
const PROGRESS_MARKER = ':::PROGRESS:::';

/** Max messages per interview to prevent runaway conversations */
const MAX_INTERVIEW_MESSAGES = 50;

const DEFAULT_SYSTEM_PROMPT = `You are the Interviewer Agent for VibCode Hub — an AI development team platform.

## Your Role in the Pipeline
You are the FIRST agent in a chain:
1. **YOU (Interviewer)** → Gather what we need to SET UP the project
2. **DevOps Agent** → Creates the repo, runs init commands, installs packages
3. **Architect Agent** → Designs the architecture (later)
4. **Issue Compiler** → Creates tickets/issues from the features (later)
5. **Developer Agent** → Writes code (later)

Your job is NOT to plan the implementation. Your job is to collect enough information so the DevOps Agent can create and initialize the project from scratch.

## What You Need to Collect (in order of priority)

### Priority 1: Project Setup (REQUIRED — DevOps Agent needs this)
- **Framework & Language**: Angular, React, Next.js, Vue, NestJS, Express, FastAPI, etc.
- **Init Command**: The exact CLI command to scaffold the project (e.g., \`npx @angular/cli new my-app --style=scss --standalone\`, \`npx create-next-app@latest\`, \`cargo init\`)
- **Additional packages**: Libraries to install after init (e.g., \`tailwindcss\`, \`prisma\`, \`@angular/material\`)
- **Dev Server**: Command and default port (Angular=4200, React/Next=3000, Vue=5173). Use \`{PORT}\` as placeholder.
- **Build Command**: e.g., \`npx ng build\`, \`npm run build\`

### Priority 2: Project Context (for later agents)
- **Short description**: 1-2 sentences about what the project does
- **Core features**: The 3-5 most important features (brief, not detailed specs)
- **Backend/Database**: If applicable (e.g., NestJS + PostgreSQL, or "no backend, client-only")

### Priority 3: Tooling (optional)
- **MCP Servers**: Suggest based on tech stack. Known servers: \`angular-mcp-server\` (Angular), \`prisma\` (Prisma ORM), \`context7\` (NestJS/general docs)

## Rules
- Ask 1-2 focused questions at a time
- **Lead with setup questions** — framework, init command, packages come FIRST
- If the user says "Angular app", you already know: init=\`npx @angular/cli new <name>\`, port=4200, build=\`npx ng build\`. Confirm and move on.
- Be practical: suggest concrete init commands and packages based on the framework choice
- Respond in the same language the user uses
- Do NOT ask about detailed UI design, API endpoints, database schemas, or implementation details — that's for later agents
- Keep it short: 3-5 questions total should be enough for a simple project
- When you have the setup info (framework, init command, dev server) + a brief feature list, finalize immediately

## Features — Detailed Capture
For each feature, capture:
- **title**: Short name (e.g. "User Authentication")
- **priority**: must-have, should-have, or nice-to-have
- **description**: 1-2 sentences about what it does
- **acceptanceCriteria**: How do we know it works? (e.g. "User can log in with email/password")

Ask briefly: "What should [feature] do? Is it must-have or nice-to-have?"

## Suggestions
After EVERY response (except the final completion), add 2-4 clickable suggestions.
These help the user answer faster. Format them on a NEW line at the very end:
${SUGGESTIONS_MARKER}["Option A", "Option B", "Option C"]

Examples:
- After asking about framework: ${SUGGESTIONS_MARKER}["Angular", "React + Next.js", "Vue + Nuxt", "NestJS API only"]
- After asking about features: ${SUGGESTIONS_MARKER}["Authentication", "Dashboard", "REST API", "Real-time updates"]
- After asking about database: ${SUGGESTIONS_MARKER}["PostgreSQL", "MongoDB", "SQLite", "No database"]

## Progress Tracking
After EVERY response (except the first), include a progress snapshot so the UI can show what's captured.
Put it on a NEW line AFTER suggestions:
${PROGRESS_MARKER}{"framework":"angular","language":"typescript","backend":"nestjs","database":"postgresql","features":[{"title":"Login","priority":"must-have"}],"setupReady":false}

Only include fields that have been determined. Omit unknown fields. "setupReady" is true when you have enough for the completion JSON.

## Completion
When you have enough info, finalize immediately — do NOT ask for extra confirmation.`;

/** Completion instructions appended to ALL system prompts (custom or default) */
const COMPLETION_INSTRUCTIONS = `

## MANDATORY Completion Format (ALWAYS follow this)
When the interview is done, end your FINAL message with EXACTLY this format.
The marker line and JSON block MUST appear — without them the system cannot proceed.

${COMPLETION_MARKER}
\`\`\`json
{
  "description": "Brief project description",
  "techStack": {
    "framework": "angular",
    "language": "typescript",
    "backend": "none",
    "database": "none",
    "additional": ["tailwindcss"]
  },
  "features": [
    { "title": "Feature 1", "priority": "must-have", "description": "What it does", "acceptanceCriteria": ["It works when..."] },
    { "title": "Feature 2", "priority": "should-have", "description": "What it does" }
  ],
  "mcpServers": [
    { "name": "angular-mcp-server", "purpose": "Angular documentation" }
  ],
  "setupInstructions": {
    "initCommand": "npx @angular/cli new my-project --style=scss --standalone",
    "additionalCommands": ["npm install tailwindcss"]
  },
  "deployment": {
    "isWebProject": true,
    "devServerPort": 4200,
    "devServerCommand": "npx ng serve --port {PORT}",
    "buildCommand": "npx ng build"
  }
}
\`\`\`

CRITICAL RULES for completion:
- The line ${COMPLETION_MARKER} must appear EXACTLY as shown (no markdown formatting around it)
- The JSON must be valid and parseable
- For devServerCommand, always use {PORT} as placeholder
- If no backend: set backend and database to "none"
- If not a web project: set deployment.isWebProject to false
- additionalCommands: one command per array entry (each will be run separately)
- initCommand: the FULL command including project name and all flags
- Do NOT ask "shall I finalize?" — just finalize when you have the info`;

@Injectable()
export class InterviewerAgent extends BaseAgent {
  readonly role = AgentRole.INTERVIEWER;
  protected readonly logger = new Logger(InterviewerAgent.name);

  constructor(
    prisma: PrismaService,
    settings: SystemSettingsService,
    chatService: ChatService,
    chatGateway: ChatGateway,
    llmService: LlmService,
    private readonly previewService: PreviewService,
    monitorGateway: MonitorGateway,
    private readonly eventEmitter: EventEmitter2,
  ) {
    super(prisma, settings, chatService, chatGateway, llmService, monitorGateway);
  }

  /** Start a new interview — generates the first question */
  async startInterview(ctx: AgentContext, projectName: string) {
    await this.updateStatus(ctx, AgentStatus.WORKING);
    await this.log(ctx.agentTaskId, 'INFO', 'Interview started', {
      projectName,
    });

    const config = this.getRoleConfig();
    const basePrompt = config.systemPrompt || DEFAULT_SYSTEM_PROMPT;
    const systemPrompt = basePrompt + COMPLETION_INSTRUCTIONS;

    // For existing projects: inject knowledge base so the interviewer knows what's already built
    const project = await this.prisma.project.findUnique({
      where: { id: ctx.projectId },
      select: { slug: true, status: true },
    });
    let projectContext = '';
    if (project?.slug) {
      const workspace = require('path').resolve(this.settings.devopsWorkspacePath, project.slug);
      const kb = await this.readProjectKnowledge(workspace);
      if (kb) {
        projectContext = `\n\nIMPORTANT: This is an EXISTING project that already has code and features. Here is the current state:\n\n${kb}\n\nBased on this, help the user add NEW features or improvements. Don't suggest things that are already implemented.`;
      }
    }

    const messages: LlmMessage[] = [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `I want to create a new project called "${projectName}". Help me figure out the tech stack and setup so the DevOps agent can initialize it.${projectContext}`,
      },
    ];

    const result = await this.callLlmStreaming(ctx, messages);

    if (result.finishReason === 'error') {
      await this.sendAgentMessage(
        ctx,
        'Sorry, I could not connect to the LLM. Please check the provider configuration in Settings.',
      );
      await this.updateStatus(ctx, AgentStatus.ERROR);
      await this.log(ctx.agentTaskId, 'ERROR', 'LLM call failed on start');
      return;
    }

    // Extract suggestions + progress, strip from displayed content
    const { content, suggestions, progress } = this.extractMetadata(result.content);

    // Save the cleaned message to DB (frontend already saw raw tokens)
    await this.sendAgentMessage(ctx, content);
    this.emitSuggestionsAndProgress(ctx, suggestions, progress);
    await this.updateStatus(ctx, AgentStatus.WAITING);
  }

  /** Continue the interview after a user message */
  async continueInterview(ctx: AgentContext) {
    // Guard: skip if interview task is already completed (prevents double-completion)
    const task = await this.prisma.agentTask.findUnique({
      where: { id: ctx.agentTaskId },
      select: { status: true },
    });
    if (!task || task.status === AgentTaskStatus.COMPLETED) {
      this.logger.debug(`Interview task ${ctx.agentTaskId} already completed — ignoring message`);
      return;
    }

    // Check message count limit
    const messageCount = await this.prisma.chatMessage.count({
      where: { chatSessionId: ctx.chatSessionId },
    });

    if (messageCount > MAX_INTERVIEW_MESSAGES) {
      await this.sendAgentMessage(
        ctx,
        'The interview has reached the maximum number of messages. Please create a new project to start over.',
      );
      await this.updateStatus(ctx, AgentStatus.ERROR);
      await this.log(ctx.agentTaskId, 'WARN', 'Interview message limit reached');
      return;
    }

    await this.updateStatus(ctx, AgentStatus.WORKING);

    // Build conversation history with system prompt + completion instructions
    const config = this.getRoleConfig();
    const basePrompt = config.systemPrompt || DEFAULT_SYSTEM_PROMPT;
    const systemPrompt = basePrompt + COMPLETION_INSTRUCTIONS;
    const history = await this.getConversationHistory(ctx.chatSessionId);

    // Prepend system prompt if not already there
    const messages: LlmMessage[] = [
      { role: 'system', content: systemPrompt },
      ...history.filter((m) => m.role !== 'system'),
    ];

    const result = await this.callLlmStreaming(ctx, messages);

    if (result.finishReason === 'error') {
      await this.sendAgentMessage(
        ctx,
        'Sorry, I could not reach the LLM. Please try again.',
      );
      await this.updateStatus(ctx, AgentStatus.ERROR);
      return;
    }

    // Check if interview is complete
    if (result.content.includes(COMPLETION_MARKER)) {
      await this.handleInterviewComplete(ctx, result.content);
    } else if (this.detectJsonCompletion(result.content)) {
      // Local LLMs often skip the exact marker but send JSON with completion signals
      this.logger.log('Detected JSON-based completion (no explicit marker)');
      await this.handleInterviewComplete(
        ctx,
        COMPLETION_MARKER + '\n' + result.content,
      );
    } else {
      // Extract suggestions + progress, strip from displayed content
      const { content, suggestions, progress } = this.extractMetadata(result.content);

      // Save the cleaned message to DB (frontend already saw tokens)
      await this.sendAgentMessage(ctx, content);
      this.emitSuggestionsAndProgress(ctx, suggestions, progress);
      await this.updateStatus(ctx, AgentStatus.WAITING);
    }
  }

  // ─── Suggestion & Progress Extraction ─────────────────────

  /**
   * Extract suggestions and progress markers from LLM response.
   * Returns cleaned content (without markers) + parsed data.
   */
  private extractMetadata(rawContent: string): {
    content: string;
    suggestions: string[];
    progress: InterviewProgress | null;
  } {
    let content = rawContent;
    let suggestions: string[] = [];
    let progress: InterviewProgress | null = null;

    // Extract suggestions: :::SUGGESTIONS:::["A", "B", "C"]
    const sugMatch = content.match(new RegExp(`${SUGGESTIONS_MARKER.replace(/:/g, '\\:')}\\s*(\\[.*?\\])`, 's'));
    if (sugMatch) {
      try {
        const parsed = JSON.parse(sugMatch[1]);
        if (Array.isArray(parsed)) {
          suggestions = parsed.map(String).slice(0, 6);
        }
      } catch {
        this.logger.debug('Failed to parse suggestions JSON');
      }
      content = content.replace(sugMatch[0], '').trim();
    }

    // Extract progress: :::PROGRESS:::{...}
    const progMatch = content.match(new RegExp(`${PROGRESS_MARKER.replace(/:/g, '\\:')}\\s*(\\{.*?\\})`, 's'));
    if (progMatch) {
      try {
        progress = JSON.parse(progMatch[1]);
      } catch {
        this.logger.debug('Failed to parse progress JSON');
      }
      content = content.replace(progMatch[0], '').trim();
    }

    return { content, suggestions, progress };
  }

  /**
   * Emit suggestions and progress to frontend via WebSocket.
   */
  private emitSuggestionsAndProgress(
    ctx: AgentContext,
    suggestions: string[],
    progress: InterviewProgress | null,
  ) {
    if (suggestions.length > 0) {
      this.chatGateway.emitToSession(ctx.chatSessionId, 'chatSuggestions', {
        chatSessionId: ctx.chatSessionId,
        suggestions,
      });
    }

    if (progress) {
      this.chatGateway.emitToSession(ctx.chatSessionId, 'interviewProgress', {
        chatSessionId: ctx.chatSessionId,
        projectId: ctx.projectId,
        progress,
      });
    }
  }

  /**
   * Detect completion from JSON-only responses where the LLM skipped the
   * :::INTERVIEW_COMPLETE::: marker but sent a structured result.
   * Checks for common patterns local LLMs use to signal completion.
   */
  private detectJsonCompletion(content: string): boolean {
    const jsonMatch = content.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/) ||
                      content.match(/(\{[\s\S]*\})/);
    if (!jsonMatch) return false;

    try {
      const obj = JSON.parse(jsonMatch[1]);

      // Check explicit completion signals
      if (obj.completion_marker === true) return true;
      if (obj.ready_for_issue_compiler === true) return true;
      if (obj.interview_status === 'completed' || obj.interview_status === 'complete') return true;

      // Check for structural completeness (has the essential keys)
      const hasSetup = !!(obj.techStack || obj.tech_stack || obj.setupInstructions || obj.setup_instructions);
      const hasFeatures = !!(obj.features || obj.core_features || obj.feature_list);
      const hasDescription = !!(obj.description || obj.summary || obj.feature_name);
      if (hasSetup && hasFeatures && hasDescription) return true;

      return false;
    } catch {
      return false;
    }
  }

  /**
   * Normalize LLM output to our InterviewResult schema.
   * LLMs (especially local ones like qwen3.5) often use different key names
   * (snake_case, synonyms, etc.) — this maps common variants to our schema.
   */
  private normalizeInterviewResult(raw: Record<string, any>): InterviewResult {
    // Helper: find a value by trying multiple key variants
    const pick = (...keys: string[]): any => {
      for (const k of keys) {
        if (raw[k] !== undefined) return raw[k];
      }
      return undefined;
    };

    // Normalize techStack — could be object or nested differently
    let techStack = pick('techStack', 'tech_stack', 'technical_stack', 'technology_stack');
    if (!techStack || typeof techStack !== 'object') {
      // Try to build from individual fields
      techStack = {
        framework: pick('framework') ?? techStack?.framework,
        language: pick('language') ?? techStack?.language,
        backend: pick('backend') ?? 'none',
        database: pick('database', 'db') ?? 'none',
        additional: pick('additional', 'additional_packages', 'packages') ?? [],
      };
    }

    // Normalize features — accepts strings, objects, or mixed
    let features = pick('features', 'core_features', 'feature_list') ?? [];
    if (Array.isArray(features)) {
      features = features.map((f: any) => {
        if (typeof f === 'string') {
          return { title: f, priority: 'should-have' as const };
        }
        if (typeof f === 'object' && f !== null) {
          return {
            title: String(f.title ?? f.name ?? f.description ?? 'Unnamed'),
            description: f.description ? String(f.description) : undefined,
            priority: this.normalizePriority(f.priority),
            acceptanceCriteria: Array.isArray(f.acceptanceCriteria ?? f.acceptance_criteria)
              ? (f.acceptanceCriteria ?? f.acceptance_criteria).map(String)
              : undefined,
          };
        }
        return { title: String(f), priority: 'should-have' as const };
      });
    }

    // Normalize setupInstructions
    let setup = pick('setupInstructions', 'setup_instructions', 'setup');
    if (!setup || typeof setup !== 'object') {
      setup = {};
    }
    const setupInstructions = {
      initCommand: setup.initCommand ?? setup.init_command ?? pick('initCommand', 'init_command'),
      additionalCommands: setup.additionalCommands ?? setup.additional_commands ?? [],
    };

    // Normalize deployment — apply framework defaults if LLM omitted fields
    let deploy = pick('deployment', 'deploy');
    if (!deploy || typeof deploy !== 'object') {
      deploy = {};
    }
    const fw = (techStack?.framework ?? '').toLowerCase();
    const frameworkDefaults = this.getFrameworkDefaults(fw);
    const deployment = {
      isWebProject: deploy.isWebProject ?? deploy.is_web_project ?? true,
      devServerPort: deploy.devServerPort ?? deploy.dev_server_port ?? deploy.port ?? frameworkDefaults.port,
      devServerCommand: deploy.devServerCommand ?? deploy.dev_server_command ?? frameworkDefaults.devCommand,
      buildCommand: deploy.buildCommand ?? deploy.build_command ?? frameworkDefaults.buildCommand,
    };

    const result: InterviewResult = {
      description: pick('description', 'summary', 'project_description', 'feature_name') ?? '',
      techStack,
      features,
      mcpServers: pick('mcpServers', 'mcp_servers') ?? [],
      setupInstructions,
      deployment,
    };

    this.logger.debug(
      `Normalized interview result: description=${!!result.description}, techStack.framework=${result.techStack?.framework}, features=${result.features?.length}`,
    );

    return result;
  }

  /** Normalize priority string to one of the three valid values */
  private normalizePriority(raw: any): 'must-have' | 'should-have' | 'nice-to-have' {
    if (!raw) return 'should-have';
    const s = String(raw).toLowerCase().replace(/[_\s]+/g, '-');
    if (s.includes('must') || s.includes('critical') || s.includes('high') || s.includes('required')) return 'must-have';
    if (s.includes('nice') || s.includes('low') || s.includes('optional')) return 'nice-to-have';
    return 'should-have';
  }

  /** Sensible deployment defaults per framework (fallback when LLM omits) */
  private getFrameworkDefaults(framework: string): {
    port?: number;
    devCommand?: string;
    buildCommand?: string;
  } {
    if (framework.includes('angular'))
      return { port: 4200, devCommand: 'npx ng serve --port {PORT}', buildCommand: 'npx ng build' };
    if (framework.includes('react') || framework.includes('next'))
      return { port: 3000, devCommand: 'npm run dev -- --port {PORT}', buildCommand: 'npm run build' };
    if (framework.includes('vue') || framework.includes('nuxt'))
      return { port: 5173, devCommand: 'npm run dev -- --port {PORT}', buildCommand: 'npm run build' };
    if (framework.includes('nest'))
      return { port: 3000, devCommand: 'npm run start:dev', buildCommand: 'npm run build' };
    if (framework.includes('express') || framework.includes('fastapi') || framework.includes('flask'))
      return { port: 3000 };
    return {};
  }

  /** Parse completion, update project, mark task done */
  private async handleInterviewComplete(ctx: AgentContext, content: string) {
    const markerIndex = content.indexOf(COMPLETION_MARKER);
    const conversationPart = content.substring(0, markerIndex).trim();
    const jsonPart = content.substring(markerIndex + COMPLETION_MARKER.length);

    // Send the conversational part (before the marker) if any
    if (conversationPart) {
      await this.sendAgentMessage(ctx, conversationPart);
    }

    // Parse the JSON result
    let interviewResult: InterviewResult;
    try {
      // Strip thinking tags that local LLMs (qwen3.5) often wrap around output
      const cleanedJson = jsonPart.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

      // Extract JSON from possible markdown code block
      const jsonMatch = cleanedJson.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON object found in completion output');
      }
      // Clean trailing commas
      let jsonStr = jsonMatch[0].replace(/,\s*([}\]])/g, '$1');
      const rawResult = JSON.parse(jsonStr);
      interviewResult = this.normalizeInterviewResult(rawResult);
    } catch (err) {
      this.logger.error(`Failed to parse interview result: ${err.message}`);
      await this.sendAgentMessage(
        ctx,
        'I finished the interview but had trouble formatting the result. Let me try again — could you confirm the details one more time?',
      );
      await this.updateStatus(ctx, AgentStatus.WAITING);
      await this.log(ctx.agentTaskId, 'ERROR', 'JSON parse failed', {
        error: err.message,
      });
      return;
    }

    // Validate essential fields
    if (!interviewResult.description || !interviewResult.techStack) {
      this.logger.warn(
        `Interview result validation failed — description: ${!!interviewResult.description}, techStack: ${!!interviewResult.techStack}. Raw keys: ${JSON.stringify(Object.keys(interviewResult))}`,
      );
      await this.sendAgentMessage(
        ctx,
        'The interview result seems incomplete. Could you provide more details about the tech stack?',
      );
      await this.updateStatus(ctx, AgentStatus.WAITING);
      return;
    }

    // Update project with interview results
    await this.prisma.project.update({
      where: { id: ctx.projectId },
      data: {
        description: interviewResult.description,
        techStack: interviewResult as any,
        status: ProjectStatus.SETTING_UP,
      },
    });

    // Mark task as completed
    await this.prisma.agentTask.update({
      where: { id: ctx.agentTaskId },
      data: {
        status: AgentTaskStatus.COMPLETED,
        output: interviewResult as any,
        completedAt: new Date(),
      },
    });

    const featureList = (interviewResult.features ?? [])
      .map(f => typeof f === 'string' ? f : `${f.title} (${f.priority})`)
      .join(', ');

    let completionMsg = `Interview complete! I've gathered all the project details. The project is now ready for setup.\n\n**Tech Stack:** ${interviewResult.techStack.framework ?? 'N/A'} + ${interviewResult.techStack.backend ?? 'N/A'}\n**Features:** ${featureList || 'N/A'}`;

    // Setup preview if it's a web project
    if (interviewResult.deployment?.isWebProject) {
      try {
        const previewUrl =
          await this.previewService.setupPreview(ctx.projectId);
        if (previewUrl) {
          const project = await this.prisma.project.findUnique({
            where: { id: ctx.projectId },
          });
          completionMsg += `\n\n**Preview:** ${previewUrl} (Port ${project?.previewPort})`;
          this.logger.log(`Preview setup for project ${ctx.projectId}: ${previewUrl}`);
        }
      } catch (err) {
        this.logger.warn(
          `Preview setup failed (non-fatal): ${err.message}`,
        );
        await this.log(ctx.agentTaskId, 'WARN', 'Preview setup failed', {
          error: err.message,
        });
      }
    }

    await this.sendAgentMessage(ctx, completionMsg);

    await this.updateStatus(ctx, AgentStatus.IDLE);
    await this.log(ctx.agentTaskId, 'INFO', 'Interview completed', {
      techStack: interviewResult.techStack,
      featureCount: interviewResult.features?.length,
      deployment: interviewResult.deployment,
    });

    // Broadcast project update for frontend
    this.chatGateway.emitToSession(ctx.chatSessionId, 'projectUpdated', {
      projectId: ctx.projectId,
      status: ProjectStatus.SETTING_UP,
    });

    // Trigger DevOps agent setup
    this.eventEmitter.emit('agent.interviewComplete', {
      projectId: ctx.projectId,
      chatSessionId: ctx.chatSessionId,
    });
  }

  // ─── Feature Interview (Dev Session) ─────────────────────

  /** Start a feature interview for a dev session */
  async startFeatureInterview(ctx: AgentContext, sessionTitle: string) {
    await this.updateStatus(ctx, AgentStatus.WORKING);
    await this.log(ctx.agentTaskId, 'INFO', 'Feature interview started', { sessionTitle });

    // Load project context
    const project = await this.prisma.project.findUnique({
      where: { id: ctx.projectId },
      select: { slug: true, name: true, techStack: true, description: true },
    });

    let envContext = '';
    let knowledgeContext = '';
    if (project?.slug) {
      const workspace = require('path').resolve(this.settings.devopsWorkspacePath, project.slug);
      const envDoc = await this.readEnvironmentDoc(workspace);
      const kb = await this.readProjectKnowledge(workspace);
      if (envDoc) envContext = `\n## Current Project Environment\n\`\`\`\n${envDoc}\n\`\`\`\n`;
      if (kb) knowledgeContext = `\n## Project Knowledge Base\n${kb}\n`;
    }

    const techStack = project?.techStack as any;
    const techLine = [techStack?.techStack?.framework, techStack?.techStack?.language, techStack?.techStack?.backend]
      .filter(Boolean).join(', ');

    const systemPrompt = this.buildFeatureInterviewPrompt(envContext, knowledgeContext, techLine);

    const messages: LlmMessage[] = [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `I want to start a new dev session called "${sessionTitle}" for project "${project?.name ?? 'Unknown'}".${
          project?.description ? ` The project is: ${project.description}` : ''
        } Help me define what features to build in this session.`,
      },
    ];

    const result = await this.callLlmStreaming(ctx, messages);

    if (result.finishReason === 'error') {
      await this.sendAgentMessage(
        ctx,
        'Sorry, I could not connect to the LLM. Please check the provider configuration.',
      );
      await this.updateStatus(ctx, AgentStatus.ERROR);
      return;
    }

    const { content, suggestions, progress } = this.extractMetadata(result.content);
    await this.sendAgentMessage(ctx, content);
    this.emitSuggestionsAndProgress(ctx, suggestions, progress);
    await this.updateStatus(ctx, AgentStatus.WAITING);
  }

  /** Continue the feature interview after a user message */
  async continueFeatureInterview(ctx: AgentContext) {
    // Guard: skip if already completed
    const task = await this.prisma.agentTask.findUnique({
      where: { id: ctx.agentTaskId },
      select: { status: true },
    });
    if (!task || task.status === AgentTaskStatus.COMPLETED) {
      this.logger.debug(`Feature interview task ${ctx.agentTaskId} already completed`);
      return;
    }

    const messageCount = await this.prisma.chatMessage.count({
      where: { chatSessionId: ctx.chatSessionId },
    });
    if (messageCount > MAX_INTERVIEW_MESSAGES) {
      await this.sendAgentMessage(ctx, 'Feature interview reached max messages. Please finalize or create a new session.');
      await this.updateStatus(ctx, AgentStatus.ERROR);
      return;
    }

    await this.updateStatus(ctx, AgentStatus.WORKING);

    // Rebuild prompt with project context
    const project = await this.prisma.project.findUnique({
      where: { id: ctx.projectId },
      select: { slug: true, techStack: true },
    });
    let envContext = '';
    let knowledgeContext = '';
    if (project?.slug) {
      const workspace = require('path').resolve(this.settings.devopsWorkspacePath, project.slug);
      const envDoc = await this.readEnvironmentDoc(workspace);
      const kb = await this.readProjectKnowledge(workspace);
      if (envDoc) envContext = `\n## Current Project Environment\n\`\`\`\n${envDoc}\n\`\`\`\n`;
      if (kb) knowledgeContext = `\n## Project Knowledge Base\n${kb}\n`;
    }
    const techStack = project?.techStack as any;
    const techLine = [techStack?.techStack?.framework, techStack?.techStack?.language, techStack?.techStack?.backend]
      .filter(Boolean).join(', ');

    const systemPrompt = this.buildFeatureInterviewPrompt(envContext, knowledgeContext, techLine);
    const history = await this.getConversationHistory(ctx.chatSessionId);
    const messages: LlmMessage[] = [
      { role: 'system', content: systemPrompt },
      ...history.filter((m) => m.role !== 'system'),
    ];

    const result = await this.callLlmStreaming(ctx, messages);

    if (result.finishReason === 'error') {
      await this.sendAgentMessage(ctx, 'Sorry, I could not reach the LLM. Please try again.');
      await this.updateStatus(ctx, AgentStatus.ERROR);
      return;
    }

    // Check for feature interview completion
    if (result.content.includes(FEATURE_COMPLETION_MARKER)) {
      await this.handleFeatureInterviewComplete(ctx, result.content);
    } else if (this.detectFeatureJsonCompletion(result.content)) {
      this.logger.log('Detected JSON-based feature interview completion');
      await this.handleFeatureInterviewComplete(
        ctx,
        FEATURE_COMPLETION_MARKER + '\n' + result.content,
      );
    } else {
      const { content, suggestions, progress } = this.extractMetadata(result.content);
      await this.sendAgentMessage(ctx, content);
      this.emitSuggestionsAndProgress(ctx, suggestions, progress);
      await this.updateStatus(ctx, AgentStatus.WAITING);
    }
  }

  /** Build the system prompt for feature interviews */
  private buildFeatureInterviewPrompt(
    envContext: string,
    knowledgeContext: string,
    techLine: string,
  ): string {
    return `You are the Feature Interviewer for VibCode Hub — a dev session planning assistant.

## Your Role
You help the user plan what features to build in this development session.
The project is ALREADY SET UP (tech stack, repo, environment all exist).
You do NOT need to ask about tech stack, framework, init commands, or deployment.

## What You Know
${techLine ? `- **Tech Stack:** ${techLine}` : '- Tech stack details are in the environment doc below'}
${envContext}
${knowledgeContext}

## What You Need to Collect
For each feature the user wants to build:
- **title**: Short name (e.g. "User Authentication", "Dashboard Charts")
- **priority**: must-have, should-have, or nice-to-have
- **description**: 1-3 sentences about what it does and WHY
- **acceptanceCriteria**: How do we know it works? (e.g. "User can log in with email/password")

## Rules
- Ask 1-2 focused questions at a time
- Be practical: suggest related features based on what you know about the project
- Respond in the same language the user uses
- Keep it short: 3-6 questions total should be enough
- When you have a clear feature list, finalize immediately — do NOT ask "shall I finalize?"
- Draw from the project knowledge base and environment doc to understand context
- Do NOT ask about tech stack, setup, or deployment — that's already done

## Suggestions
After EVERY response (except the final completion), add 2-4 clickable suggestions:
${SUGGESTIONS_MARKER}["Feature idea A", "Feature idea B", "That's all, let's go!"]

## Completion
When you have enough features, finalize with EXACTLY this format:

${FEATURE_COMPLETION_MARKER}
\`\`\`json
{
  "sessionGoal": "Brief description of this session's goal",
  "features": [
    {
      "title": "Feature Name",
      "priority": "must-have",
      "description": "What it does and why",
      "acceptanceCriteria": ["Criteria 1", "Criteria 2"]
    }
  ]
}
\`\`\`

CRITICAL: The marker ${FEATURE_COMPLETION_MARKER} must appear EXACTLY as shown.
The JSON must be valid. Do NOT ask for confirmation — just finalize when ready.`;
  }

  /** Detect JSON-only completion for feature interviews */
  private detectFeatureJsonCompletion(content: string): boolean {
    const jsonMatch = content.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/) ||
                      content.match(/(\{[\s\S]*\})/);
    if (!jsonMatch) return false;

    try {
      const obj = JSON.parse(jsonMatch[1]);
      const hasFeatures = !!(obj.features || obj.feature_list);
      const hasGoal = !!(obj.sessionGoal || obj.session_goal || obj.goal || obj.description);
      return hasFeatures && hasGoal;
    } catch {
      return false;
    }
  }

  /** Handle feature interview completion — parse result and trigger pipeline */
  private async handleFeatureInterviewComplete(ctx: AgentContext, content: string) {
    const markerIndex = content.indexOf(FEATURE_COMPLETION_MARKER);
    const conversationPart = content.substring(0, markerIndex).trim();
    const jsonPart = content.substring(markerIndex + FEATURE_COMPLETION_MARKER.length);

    if (conversationPart) {
      await this.sendAgentMessage(ctx, conversationPart);
    }

    let featureResult: FeatureInterviewResult;
    try {
      const cleanedJson = jsonPart.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      const jsonMatch = cleanedJson.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON object found');
      const jsonStr = jsonMatch[0].replace(/,\s*([}\]])/g, '$1');
      const raw = JSON.parse(jsonStr);

      // Normalize
      const features = (raw.features || raw.feature_list || []).map((f: any) => {
        if (typeof f === 'string') return { title: f, priority: 'should-have' as const };
        return {
          title: String(f.title ?? f.name ?? 'Unnamed'),
          description: f.description ? String(f.description) : undefined,
          priority: this.normalizePriority(f.priority),
          acceptanceCriteria: Array.isArray(f.acceptanceCriteria ?? f.acceptance_criteria)
            ? (f.acceptanceCriteria ?? f.acceptance_criteria).map(String)
            : undefined,
        };
      });

      featureResult = {
        sessionGoal: raw.sessionGoal ?? raw.session_goal ?? raw.goal ?? raw.description ?? '',
        features,
      };
    } catch (err) {
      this.logger.error(`Failed to parse feature interview result: ${err.message}`);
      await this.sendAgentMessage(
        ctx,
        'I had trouble formatting the feature list. Could you confirm the features one more time?',
      );
      await this.updateStatus(ctx, AgentStatus.WAITING);
      return;
    }

    if (!featureResult.features || featureResult.features.length === 0) {
      await this.sendAgentMessage(ctx, 'No features captured. Please describe at least one feature to build.');
      await this.updateStatus(ctx, AgentStatus.WAITING);
      return;
    }

    // Mark task completed
    await this.prisma.agentTask.update({
      where: { id: ctx.agentTaskId },
      data: {
        status: AgentTaskStatus.COMPLETED,
        output: featureResult as any,
        completedAt: new Date(),
      },
    });

    const featureList = featureResult.features
      .map(f => `${f.title} (${f.priority})`)
      .join(', ');

    await this.sendAgentMessage(
      ctx,
      `Feature interview complete! 🎯\n\n**Session Goal:** ${featureResult.sessionGoal}\n**Features:** ${featureList}\n\nStarting the pipeline — Architect will design the implementation next.`,
    );

    await this.updateStatus(ctx, AgentStatus.IDLE);
    await this.log(ctx.agentTaskId, 'INFO', 'Feature interview completed', {
      sessionGoal: featureResult.sessionGoal,
      featureCount: featureResult.features.length,
    });

    // Trigger pipeline: Architect → Issue Compiler → Coder → etc.
    this.eventEmitter.emit('agent.featureInterviewComplete', {
      projectId: ctx.projectId,
      chatSessionId: ctx.chatSessionId,
      featureResult,
    });
  }
}
