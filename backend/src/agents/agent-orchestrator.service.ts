import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import { ChatService } from '../chat/chat.service';
import { SystemSettingsService } from '../settings/system-settings.service';
import { InterviewerAgent } from './interviewer/interviewer.agent';
import { DevopsAgent } from './devops/devops.agent';
import { IssueCompilerAgent } from './issue-compiler/issue-compiler.agent';
import {
  AgentRole,
  AgentStatus,
  AgentTaskType,
  AgentTaskStatus,
  ProjectStatus,
} from '@prisma/client';

@Injectable()
export class AgentOrchestratorService {
  private readonly logger = new Logger(AgentOrchestratorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly chatService: ChatService,
    private readonly settings: SystemSettingsService,
    private readonly interviewer: InterviewerAgent,
    private readonly devops: DevopsAgent,
    private readonly issueCompiler: IssueCompilerAgent,
  ) {}

  /**
   * Start an interview for a project.
   * Creates AgentInstance, AgentTask, ChatSession, and kicks off the first question.
   */
  async startInterview(projectId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
    });
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    // Get interviewer config for provider/model
    const config = this.settings.getAgentRoleConfig('INTERVIEWER');

    // Create agent instance
    const agentInstance = await this.prisma.agentInstance.create({
      data: {
        projectId,
        role: AgentRole.INTERVIEWER,
        provider: config.provider as any,
        model: config.model,
        status: AgentStatus.IDLE,
      },
    });

    // Create agent task
    const agentTask = await this.prisma.agentTask.create({
      data: {
        agentId: agentInstance.id,
        type: AgentTaskType.INTERVIEW,
        status: AgentTaskStatus.RUNNING,
        startedAt: new Date(),
      },
    });

    // Create chat session for the interview
    const chatSession = await this.chatService.createSession({
      projectId,
      title: 'Project Interview',
    });

    const ctx = {
      projectId,
      agentInstanceId: agentInstance.id,
      agentTaskId: agentTask.id,
      chatSessionId: chatSession.id,
    };

    // Start the interview asynchronously (don't block the response)
    this.interviewer.startInterview(ctx, project.name).catch((err) => {
      this.logger.error(`Failed to start interview: ${err.message}`);
    });

    return {
      agentInstanceId: agentInstance.id,
      agentTaskId: agentTask.id,
      chatSessionId: chatSession.id,
    };
  }

  /**
   * Handle user messages — if there's an active interview, route to the interviewer.
   * Triggered by EventEmitter from ChatGateway.
   */
  @OnEvent('chat.userMessage')
  async handleUserMessage(payload: {
    chatSessionId: string;
    content: string;
  }) {
    const { chatSessionId } = payload;

    // Find an active interview task for this chat session
    const chatSession = await this.prisma.chatSession.findUnique({
      where: { id: chatSessionId },
      select: { projectId: true },
    });

    if (!chatSession) return;

    // Look for an active interviewer agent with a running task
    const activeAgent = await this.prisma.agentInstance.findFirst({
      where: {
        projectId: chatSession.projectId,
        role: AgentRole.INTERVIEWER,
        status: { in: [AgentStatus.WAITING, AgentStatus.WORKING] },
      },
      include: {
        tasks: {
          where: { status: AgentTaskStatus.RUNNING },
          take: 1,
        },
      },
    });

    if (!activeAgent || activeAgent.tasks.length === 0) return;

    const ctx = {
      projectId: chatSession.projectId,
      agentInstanceId: activeAgent.id,
      agentTaskId: activeAgent.tasks[0].id,
      chatSessionId,
    };

    this.logger.debug(
      `Routing user message to interviewer for project ${chatSession.projectId}`,
    );

    // Continue the interview asynchronously
    this.interviewer.continueInterview(ctx).catch((err) => {
      this.logger.error(`Interviewer error: ${err.message}`);
    });
  }

  /** Get agent status for a project */
  async getProjectAgentStatus(projectId: string) {
    return this.prisma.agentInstance.findMany({
      where: { projectId },
      include: {
        tasks: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });
  }

  // ─── DevOps Agent ──────────────────────────────────────────

  /**
   * Handle interview completion — automatically start DevOps setup.
   * Reuses the same chat session for seamless flow.
   */
  @OnEvent('agent.interviewComplete')
  async handleInterviewComplete(payload: {
    projectId: string;
    chatSessionId: string;
  }) {
    const { projectId, chatSessionId } = payload;
    this.logger.log(`Interview complete for project ${projectId} — starting DevOps setup`);

    try {
      await this.startDevopsSetup(projectId, chatSessionId);
    } catch (err) {
      this.logger.error(`Failed to start DevOps setup: ${err.message}`);
    }
  }

  /**
   * Start the DevOps agent for project setup.
   * Creates AgentInstance + AgentTask, reuses the given chat session.
   */
  async startDevopsSetup(projectId: string, chatSessionId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
    });
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    // Get DevOps config for provider/model
    const config = this.settings.getAgentRoleConfig('DEVOPS');

    // Create agent instance
    const agentInstance = await this.prisma.agentInstance.create({
      data: {
        projectId,
        role: AgentRole.DEVOPS,
        provider: config.provider as any,
        model: config.model,
        status: AgentStatus.IDLE,
      },
    });

    // Create agent task
    const agentTask = await this.prisma.agentTask.create({
      data: {
        agentId: agentInstance.id,
        type: AgentTaskType.DEPLOY,
        status: AgentTaskStatus.RUNNING,
        startedAt: new Date(),
      },
    });

    const ctx = {
      projectId,
      agentInstanceId: agentInstance.id,
      agentTaskId: agentTask.id,
      chatSessionId,
    };

    // Start setup asynchronously (don't block)
    this.devops.runSetup(ctx).catch((err) => {
      this.logger.error(`DevOps setup error: ${err.message}`);
    });

    return {
      agentInstanceId: agentInstance.id,
      agentTaskId: agentTask.id,
      chatSessionId,
    };
  }

  // ─── Issue Compiler Agent ───────────────────────────────────

  /**
   * Handle DevOps completion — automatically start Issue Compiler.
   * Reuses the same chat session for seamless flow.
   */
  @OnEvent('agent.devopsComplete')
  async handleDevopsComplete(payload: {
    projectId: string;
    chatSessionId: string;
  }) {
    const { projectId, chatSessionId } = payload;
    this.logger.log(`DevOps complete for project ${projectId} — starting Issue Compiler`);

    try {
      await this.startIssueCompilation(projectId, chatSessionId);
    } catch (err) {
      this.logger.error(`Failed to start Issue Compiler: ${err.message}`);
    }
  }

  /**
   * Start the Issue Compiler agent.
   * Creates AgentInstance + AgentTask, reuses the given chat session.
   */
  async startIssueCompilation(projectId: string, chatSessionId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
    });
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    // Get Issue Compiler config for provider/model
    const config = this.settings.getAgentRoleConfig('ISSUE_COMPILER');

    // Create agent instance
    const agentInstance = await this.prisma.agentInstance.create({
      data: {
        projectId,
        role: AgentRole.ISSUE_COMPILER,
        provider: config.provider as any,
        model: config.model,
        status: AgentStatus.IDLE,
      },
    });

    // Create agent task
    const agentTask = await this.prisma.agentTask.create({
      data: {
        agentId: agentInstance.id,
        type: AgentTaskType.CREATE_ISSUES,
        status: AgentTaskStatus.RUNNING,
        startedAt: new Date(),
      },
    });

    const ctx = {
      projectId,
      agentInstanceId: agentInstance.id,
      agentTaskId: agentTask.id,
      chatSessionId,
    };

    // Start compilation asynchronously (don't block)
    this.issueCompiler.runCompilation(ctx).catch((err) => {
      this.logger.error(`Issue Compiler error: ${err.message}`);
    });

    return {
      agentInstanceId: agentInstance.id,
      agentTaskId: agentTask.id,
      chatSessionId,
    };
  }
}
