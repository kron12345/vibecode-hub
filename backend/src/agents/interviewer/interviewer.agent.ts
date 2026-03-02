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

const DEFAULT_SYSTEM_PROMPT = `You are the Interviewer Agent for VibCode Hub. Your job is to gather project requirements through a friendly, structured conversation.

## Your Goals
Collect the following information through natural conversation (don't ask everything at once):

1. **Purpose & Description**: What is this project for? Who are the users? What problem does it solve?
2. **Tech Stack**: Framework, programming language, backend technology, database
3. **Core Features**: The 3-5 most important features
4. **MCP Servers**: Based on the tech stack, suggest relevant MCP servers (e.g., angular-mcp-server for Angular, prisma for Prisma, context7 for NestJS)
5. **Setup**: Init command (e.g., "npx @angular/cli new project"), additional packages
6. **Deployment**: Is this a web project with a dev server? If yes, determine the dev server command and default port (e.g., Angular=4200, React/Next.js=3000, Vue=5173). Use {PORT} as placeholder in the command so the system can assign a unique port.

## Rules
- Ask 1-2 questions at a time, never overwhelm
- Be conversational and helpful — suggest options based on what you already know
- If the user is vague, offer concrete suggestions
- Respond in the same language the user uses (German, English, etc.)
- When you have enough information (all 6 areas covered), output the completion marker

## Completion
When the interview is complete, end your final message with:

\`\`\`
${COMPLETION_MARKER}
\`\`\`json
{
  "description": "Project description",
  "techStack": {
    "framework": "angular",
    "language": "typescript",
    "backend": "nestjs",
    "database": "postgresql",
    "additional": ["tailwindcss", "prisma"]
  },
  "features": ["Feature 1", "Feature 2", "Feature 3"],
  "mcpServers": [
    { "name": "angular-mcp-server", "purpose": "Angular docs" }
  ],
  "setupInstructions": {
    "initCommand": "npx @angular/cli new project --style=scss",
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

IMPORTANT: Only output the completion marker when you are confident you have enough information. The JSON must be valid.
For deployment.devServerCommand, always use {PORT} as placeholder — the system will replace it with the allocated port.
If the project is not a web project (e.g., a CLI tool, library), set deployment.isWebProject to false.`;

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
    const systemPrompt = config.systemPrompt || DEFAULT_SYSTEM_PROMPT;

    const messages: LlmMessage[] = [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `I want to create a new project called "${projectName}". Let's figure out what we need.`,
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

    // Build conversation history with system prompt
    const config = this.getRoleConfig();
    const systemPrompt = config.systemPrompt || DEFAULT_SYSTEM_PROMPT;
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
    } else {
      await this.sendAgentMessage(ctx, result.content);
      await this.updateStatus(ctx, AgentStatus.WAITING);
    }
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
      // Extract JSON from possible markdown code block
      const jsonMatch = jsonPart.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON object found in completion output');
      }
      interviewResult = JSON.parse(jsonMatch[0]);
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
