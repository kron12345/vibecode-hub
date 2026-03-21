import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import { SystemSettingsService } from '../../settings/system-settings.service';
import { ChatService } from '../../chat/chat.service';
import { ChatGateway } from '../../chat/chat.gateway';
import { LlmService } from '../../llm/llm.service';
import { LlmMessage } from '../../llm/llm.interfaces';
import { GitlabService } from '../../gitlab/gitlab.service';
import { PreviewService } from '../../preview/preview.service';
import { MonitorGateway } from '../../monitor/monitor.gateway';
import { BaseAgent, AgentContext, sanitizeJsonOutput } from '../agent-base';
import { loadPrompt } from '../prompt-loader';
import {
  InterviewResult,
  FeatureInterviewResult,
  InterviewProgress,
} from './interview-result.interface';
import {
  COMPLETION_MARKER,
  FEATURE_COMPLETION_MARKER,
  COMPLETION_INSTRUCTIONS,
  extractMetadata,
  detectJsonCompletion,
  detectFeatureJsonCompletion,
  normalizeInterviewResult,
  normalizePriority,
  buildFeatureInterviewPrompt,
} from './interviewer-prompt';
import {
  AgentRole,
  AgentStatus,
  AgentTaskStatus,
  ProjectStatus,
} from '@prisma/client';

/** Fallback max messages per interview (overridden by pipeline config) */
const FALLBACK_MAX_INTERVIEW_MESSAGES = 50;

const DEFAULT_SYSTEM_PROMPT = loadPrompt('interviewer');

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
    private readonly gitlabService: GitlabService,
    private readonly previewService: PreviewService,
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
      select: { slug: true, status: true, gitlabProjectId: true },
    });
    let projectContext = '';
    if (project?.slug) {
      const workspace = require('path').resolve(
        this.settings.devopsWorkspacePath,
        project.slug,
      );
      const kb = await this.readKnowledge(
        this.gitlabService,
        project.gitlabProjectId,
        workspace,
      );
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
    const { content, suggestions, progress } = extractMetadata(result.content);

    await this.sendAgentMessage(ctx, content);
    this.emitSuggestionsAndProgress(ctx, suggestions, progress);
    await this.updateStatus(ctx, AgentStatus.WAITING);
  }

  /** Continue the interview after a user message */
  async continueInterview(ctx: AgentContext) {
    // Guard: skip if interview task is already completed
    const task = await this.prisma.agentTask.findUnique({
      where: { id: ctx.agentTaskId },
      select: { status: true },
    });
    if (!task || task.status === AgentTaskStatus.COMPLETED) {
      this.logger.debug(
        `Interview task ${ctx.agentTaskId} already completed — ignoring message`,
      );
      return;
    }

    // Check message count limit
    const messageCount = await this.prisma.chatMessage.count({
      where: { chatSessionId: ctx.chatSessionId },
    });

    if (
      messageCount >
      (this.settings.getPipelineConfig().maxInterviewMessages ??
        FALLBACK_MAX_INTERVIEW_MESSAGES)
    ) {
      await this.sendAgentMessage(
        ctx,
        'The interview has reached the maximum number of messages. Please create a new project to start over.',
      );
      await this.updateStatus(ctx, AgentStatus.ERROR);
      await this.log(
        ctx.agentTaskId,
        'WARN',
        'Interview message limit reached',
      );
      return;
    }

    await this.updateStatus(ctx, AgentStatus.WORKING);

    // Build conversation history with system prompt + completion instructions
    const config = this.getRoleConfig();
    const basePrompt = config.systemPrompt || DEFAULT_SYSTEM_PROMPT;
    const systemPrompt = basePrompt + COMPLETION_INSTRUCTIONS;
    const history = await this.getConversationHistory(ctx.chatSessionId);

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
    } else if (detectJsonCompletion(result.content)) {
      this.logger.log('Detected JSON-based completion (no explicit marker)');
      await this.handleInterviewComplete(
        ctx,
        COMPLETION_MARKER + '\n' + result.content,
      );
    } else {
      const { content, suggestions, progress } = extractMetadata(
        result.content,
      );
      await this.sendAgentMessage(ctx, content);
      this.emitSuggestionsAndProgress(ctx, suggestions, progress);
      await this.updateStatus(ctx, AgentStatus.WAITING);
    }
  }

  // ─── Suggestion & Progress Emission ─────────────────────

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

  /** Parse completion, update project, mark task done */
  private async handleInterviewComplete(ctx: AgentContext, content: string) {
    const markerIndex = content.indexOf(COMPLETION_MARKER);
    const conversationPart = content.substring(0, markerIndex).trim();
    const jsonPart = content.substring(markerIndex + COMPLETION_MARKER.length);

    if (conversationPart) {
      await this.sendAgentMessage(ctx, conversationPart);
    }

    // Parse the JSON result
    let interviewResult: InterviewResult;
    try {
      const cleanedJson = jsonPart
        .replace(/<think>[\s\S]*?<\/think>/g, '')
        .trim();

      const jsonMatch = cleanedJson.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON object found in completion output');
      }
      const jsonStr = jsonMatch[0].replace(/,\s*([}\]])/g, '$1');
      const rawResult = JSON.parse(jsonStr);
      interviewResult = normalizeInterviewResult(rawResult);
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
        output: sanitizeJsonOutput(interviewResult) as any,
        completedAt: new Date(),
      },
    });

    const featureList = (interviewResult.features ?? [])
      .map((f) => (typeof f === 'string' ? f : `${f.title} (${f.priority})`))
      .join(', ');

    let completionMsg = `Interview complete! I've gathered all the project details. The project is now ready for setup.\n\n**Tech Stack:** ${interviewResult.techStack.framework ?? 'N/A'} + ${interviewResult.techStack.backend ?? 'N/A'}\n**Features:** ${featureList || 'N/A'}`;

    // Setup preview if it's a web project
    if (interviewResult.deployment?.isWebProject) {
      try {
        const previewUrl = await this.previewService.setupPreview(
          ctx.projectId,
        );
        if (previewUrl) {
          const project = await this.prisma.project.findUnique({
            where: { id: ctx.projectId },
          });
          completionMsg += `\n\n**Preview:** ${previewUrl} (Port ${project?.previewPort})`;
          this.logger.log(
            `Preview setup for project ${ctx.projectId}: ${previewUrl}`,
          );
        }
      } catch (err) {
        this.logger.warn(`Preview setup failed (non-fatal): ${err.message}`);
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
    await this.log(ctx.agentTaskId, 'INFO', 'Feature interview started', {
      sessionTitle,
    });

    // Load project context
    const project = await this.prisma.project.findUnique({
      where: { id: ctx.projectId },
      select: {
        slug: true,
        name: true,
        techStack: true,
        description: true,
        gitlabProjectId: true,
      },
    });

    let envContext = '';
    let knowledgeContext = '';
    if (project?.slug) {
      const workspace = await this.resolveWorkspace(
        project.slug,
        ctx.chatSessionId,
      );
      const envDoc = await this.readEnvironment(
        this.gitlabService,
        project.gitlabProjectId,
        workspace,
      );
      const kb = await this.readKnowledge(
        this.gitlabService,
        project.gitlabProjectId,
        workspace,
      );
      if (envDoc)
        envContext = `\n## Current Project Environment\n\`\`\`\n${envDoc}\n\`\`\`\n`;
      if (kb) knowledgeContext = `\n## Project Knowledge Base\n${kb}\n`;
    }

    const techStack = project?.techStack as any;
    const techLine = [
      techStack?.techStack?.framework,
      techStack?.techStack?.language,
      techStack?.techStack?.backend,
    ]
      .filter(Boolean)
      .join(', ');

    const systemPrompt = buildFeatureInterviewPrompt(
      envContext,
      knowledgeContext,
      techLine,
    );

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

    const { content, suggestions, progress } = extractMetadata(result.content);
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
      this.logger.debug(
        `Feature interview task ${ctx.agentTaskId} already completed`,
      );
      return;
    }

    const messageCount = await this.prisma.chatMessage.count({
      where: { chatSessionId: ctx.chatSessionId },
    });
    if (
      messageCount >
      (this.settings.getPipelineConfig().maxInterviewMessages ??
        FALLBACK_MAX_INTERVIEW_MESSAGES)
    ) {
      await this.sendAgentMessage(
        ctx,
        'Feature interview reached max messages. Please finalize or create a new session.',
      );
      await this.updateStatus(ctx, AgentStatus.ERROR);
      return;
    }

    await this.updateStatus(ctx, AgentStatus.WORKING);

    // Rebuild prompt with project context
    const project = await this.prisma.project.findUnique({
      where: { id: ctx.projectId },
      select: { slug: true, techStack: true, gitlabProjectId: true },
    });
    let envContext = '';
    let knowledgeContext = '';
    if (project?.slug) {
      const workspace = await this.resolveWorkspace(
        project.slug,
        ctx.chatSessionId,
      );
      const envDoc = await this.readEnvironment(
        this.gitlabService,
        project.gitlabProjectId,
        workspace,
      );
      const kb = await this.readKnowledge(
        this.gitlabService,
        project.gitlabProjectId,
        workspace,
      );
      if (envDoc)
        envContext = `\n## Current Project Environment\n\`\`\`\n${envDoc}\n\`\`\`\n`;
      if (kb) knowledgeContext = `\n## Project Knowledge Base\n${kb}\n`;
    }
    const techStack = project?.techStack as any;
    const techLine = [
      techStack?.techStack?.framework,
      techStack?.techStack?.language,
      techStack?.techStack?.backend,
    ]
      .filter(Boolean)
      .join(', ');

    const systemPrompt = buildFeatureInterviewPrompt(
      envContext,
      knowledgeContext,
      techLine,
    );
    const history = await this.getConversationHistory(ctx.chatSessionId);
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

    // Check for feature interview completion
    if (result.content.includes(FEATURE_COMPLETION_MARKER)) {
      await this.handleFeatureInterviewComplete(ctx, result.content);
    } else if (detectFeatureJsonCompletion(result.content)) {
      this.logger.log('Detected JSON-based feature interview completion');
      await this.handleFeatureInterviewComplete(
        ctx,
        FEATURE_COMPLETION_MARKER + '\n' + result.content,
      );
    } else {
      const { content, suggestions, progress } = extractMetadata(
        result.content,
      );
      await this.sendAgentMessage(ctx, content);
      this.emitSuggestionsAndProgress(ctx, suggestions, progress);
      await this.updateStatus(ctx, AgentStatus.WAITING);
    }
  }

  /** Handle feature interview completion — parse result and trigger pipeline */
  private async handleFeatureInterviewComplete(
    ctx: AgentContext,
    content: string,
  ) {
    const markerIndex = content.indexOf(FEATURE_COMPLETION_MARKER);
    const conversationPart = content.substring(0, markerIndex).trim();
    const jsonPart = content.substring(
      markerIndex + FEATURE_COMPLETION_MARKER.length,
    );

    if (conversationPart) {
      await this.sendAgentMessage(ctx, conversationPart);
    }

    let featureResult: FeatureInterviewResult;
    try {
      const cleanedJson = jsonPart
        .replace(/<think>[\s\S]*?<\/think>/g, '')
        .trim();
      const jsonMatch = cleanedJson.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON object found');
      const jsonStr = jsonMatch[0].replace(/,\s*([}\]])/g, '$1');
      const raw = JSON.parse(jsonStr);

      // Normalize
      const features = (raw.features || raw.feature_list || []).map(
        (f: any) => {
          if (typeof f === 'string')
            return { title: f, priority: 'should-have' as const };
          return {
            title: String(f.title ?? f.name ?? 'Unnamed'),
            description: f.description ? String(f.description) : undefined,
            priority: normalizePriority(f.priority),
            acceptanceCriteria: Array.isArray(
              f.acceptanceCriteria ?? f.acceptance_criteria,
            )
              ? (f.acceptanceCriteria ?? f.acceptance_criteria).map(String)
              : undefined,
          };
        },
      );

      featureResult = {
        sessionGoal:
          raw.sessionGoal ??
          raw.session_goal ??
          raw.goal ??
          raw.description ??
          '',
        features,
      };
    } catch (err) {
      this.logger.error(
        `Failed to parse feature interview result: ${err.message}`,
      );
      await this.sendAgentMessage(
        ctx,
        'I had trouble formatting the feature list. Could you confirm the features one more time?',
      );
      await this.updateStatus(ctx, AgentStatus.WAITING);
      return;
    }

    if (!featureResult.features || featureResult.features.length === 0) {
      await this.sendAgentMessage(
        ctx,
        'No features captured. Please describe at least one feature to build.',
      );
      await this.updateStatus(ctx, AgentStatus.WAITING);
      return;
    }

    // Mark task completed
    await this.prisma.agentTask.update({
      where: { id: ctx.agentTaskId },
      data: {
        status: AgentTaskStatus.COMPLETED,
        output: sanitizeJsonOutput(featureResult) as any,
        completedAt: new Date(),
      },
    });

    const featureList = featureResult.features
      .map((f) => `${f.title} (${f.priority})`)
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

    // Trigger pipeline: Architect -> Issue Compiler -> Coder -> etc.
    this.eventEmitter.emit('agent.featureInterviewComplete', {
      projectId: ctx.projectId,
      chatSessionId: ctx.chatSessionId,
      featureResult,
    });
  }
}
