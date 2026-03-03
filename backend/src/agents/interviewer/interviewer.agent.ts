import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import { SystemSettingsService } from '../../settings/system-settings.service';
import { ChatService } from '../../chat/chat.service';
import { ChatGateway } from '../../chat/chat.gateway';
import { LlmService } from '../../llm/llm.service';
import { LlmMessage } from '../../llm/llm.interfaces';
import { PreviewService } from '../../preview/preview.service';
import { BaseAgent, AgentContext } from '../agent-base';
import { InterviewResult } from './interview-result.interface';
import {
  AgentRole,
  AgentStatus,
  AgentTaskStatus,
  ProjectStatus,
} from '@prisma/client';

/** Marker the LLM emits when the interview is complete */
const COMPLETION_MARKER = ':::INTERVIEW_COMPLETE:::';

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
  "features": ["Feature 1", "Feature 2", "Feature 3"],
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
    private readonly eventEmitter: EventEmitter2,
  ) {
    super(prisma, settings, chatService, chatGateway, llmService);
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

    const messages: LlmMessage[] = [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `I want to create a new project called "${projectName}". Help me figure out the tech stack and setup so the DevOps agent can initialize it.`,
      },
    ];

    const result = await this.callLlm(messages);

    if (result.finishReason === 'error') {
      await this.sendAgentMessage(
        ctx,
        'Sorry, I could not connect to the LLM. Please check the provider configuration in Settings.',
      );
      await this.updateStatus(ctx, AgentStatus.ERROR);
      await this.log(ctx.agentTaskId, 'ERROR', 'LLM call failed on start');
      return;
    }

    await this.sendAgentMessage(ctx, result.content);
    await this.updateStatus(ctx, AgentStatus.WAITING);
  }

  /** Continue the interview after a user message */
  async continueInterview(ctx: AgentContext) {
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

    const result = await this.callLlm(messages);

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
      await this.sendAgentMessage(ctx, result.content);
      await this.updateStatus(ctx, AgentStatus.WAITING);
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

    // Normalize features — could be array of strings or array of objects
    let features = pick('features', 'core_features', 'feature_list') ?? [];
    if (Array.isArray(features) && features.length > 0 && typeof features[0] === 'object') {
      features = features.map((f: any) => f.name || f.title || f.description || String(f));
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

    let completionMsg = `Interview complete! I've gathered all the project details. The project is now ready for setup.\n\n**Tech Stack:** ${interviewResult.techStack.framework ?? 'N/A'} + ${interviewResult.techStack.backend ?? 'N/A'}\n**Features:** ${interviewResult.features?.join(', ') ?? 'N/A'}`;

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
}
