import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import { ChatService } from '../chat/chat.service';
import { ChatGateway } from '../chat/chat.gateway';
import { GitlabService } from '../gitlab/gitlab.service';
import {
  AgentRole,
  AgentStatus,
  AgentTaskStatus,
  MessageVisibility,
} from '@prisma/client';
import { AgentContext } from './agent-base';

export interface ClarificationRequest {
  question: string;
  options?: string[];
  context?: string;
  issueId?: string;
}

/**
 * ClarificationService — allows agents to ask the user for input
 * when requirements are ambiguous.
 *
 * Flow:
 * 1. Agent calls askUser() → posts question to chat, task → WAITING_FOR_INPUT
 * 2. Pipeline pauses for this issue (other issues continue)
 * 3. User answers in chat
 * 4. Orchestrator detects WAITING_FOR_INPUT task → routes answer here
 * 5. handleUserAnswer() → appends clarification to issue description → resumes pipeline
 */
@Injectable()
export class ClarificationService {
  private readonly logger = new Logger(ClarificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly chatService: ChatService,
    private readonly chatGateway: ChatGateway,
    private readonly gitlabService: GitlabService,
  ) {}

  /**
   * Agent asks the user a question. Pipeline pauses until answered.
   *
   * @returns true if the question was posted (caller should return/exit)
   */
  async askUser(
    ctx: AgentContext,
    agentRole: AgentRole,
    request: ClarificationRequest,
  ): Promise<boolean> {
    const { question, options, context, issueId } = request;

    // Build the question message
    const roleName = this.formatRoleName(agentRole);
    let messageContent = `**${roleName} needs your input:**\n\n${question}`;

    if (context) {
      messageContent += `\n\n**Context:** ${context}`;
    }

    if (options && options.length > 0) {
      messageContent += '\n\n**Options:**\n';
      options.forEach((opt, i) => {
        messageContent += `${i + 1}. ${opt}\n`;
      });
    }

    messageContent += '\n\n*Please reply in this chat. The pipeline will resume automatically.*';

    // Post question as USER_FACING message
    const msg = await this.chatService.addMessage({
      chatSessionId: ctx.chatSessionId,
      role: 'AGENT' as any,
      content: messageContent,
      metadata: {
        clarificationRequest: true,
        agentRole,
        issueId,
        question,
      },
    });

    // Update message visibility to USER_FACING
    await this.prisma.chatMessage.update({
      where: { id: msg.id },
      data: { visibility: MessageVisibility.USER_FACING },
    });

    // Set task to WAITING_FOR_INPUT
    await this.prisma.agentTask.update({
      where: { id: ctx.agentTaskId },
      data: {
        status: AgentTaskStatus.WAITING_FOR_INPUT,
        input: {
          clarification: {
            question,
            options,
            context,
            issueId,
            agentRole: String(agentRole),
            askedAt: new Date().toISOString(),
          },
        } as any,
      },
    });

    // Set agent to WAITING
    await this.prisma.agentInstance.update({
      where: { id: ctx.agentInstanceId },
      data: { status: AgentStatus.WAITING },
    });

    // Emit WebSocket event so frontend can show indicator
    this.chatGateway.emitToSession(
      ctx.chatSessionId,
      'clarificationRequired',
      {
        chatSessionId: ctx.chatSessionId,
        agentRole,
        question,
        taskId: ctx.agentTaskId,
        issueId,
      },
    );
    this.chatGateway.emitToSession(ctx.chatSessionId, 'newMessage', msg);

    // Emit event for external notification channels (Telegram, etc.)
    this.eventEmitter.emit('clarification.requested', {
      chatSessionId: ctx.chatSessionId,
      agentRole: roleName,
      question,
      options,
      issueId,
    });

    this.logger.log(
      `${roleName} asked for clarification (task ${ctx.agentTaskId}): ${question.substring(0, 100)}`,
    );

    return true;
  }

  /**
   * Handle user's answer to a clarification question.
   * Appends the clarification to the issue description and resumes the pipeline.
   */
  async handleUserAnswer(
    projectId: string,
    chatSessionId: string,
    userAnswer: string,
    waitingTask: {
      id: string;
      type: string;
      input: any;
      agent: { role: AgentRole; id: string };
      issueId: string | null;
    },
  ): Promise<{
    handled: boolean;
    resumeAction?: string;
    issueId?: string;
  }> {
    const clarification = waitingTask.input?.clarification;
    if (!clarification) {
      this.logger.warn(
        `WAITING_FOR_INPUT task ${waitingTask.id} has no clarification context`,
      );
      return { handled: false };
    }

    const issueId = clarification.issueId ?? waitingTask.issueId;
    const agentRole = clarification.agentRole;
    const question = clarification.question;

    this.logger.log(
      `User answered clarification for ${agentRole} (issue ${issueId}): ${userAnswer.substring(0, 100)}`,
    );

    // Append clarification to issue description
    if (issueId) {
      const issue = await this.prisma.issue.findUnique({
        where: { id: issueId },
        select: {
          description: true,
          gitlabIid: true,
          project: { select: { gitlabProjectId: true } },
        },
      });

      if (issue) {
        const clarificationBlock =
          `\n\n---\n**Clarification** (from user, answering ${this.formatRoleName(agentRole as AgentRole)}):\n` +
          `> **Q:** ${question}\n>\n` +
          `> **A:** ${userAnswer}\n---\n`;

        const updatedDesc =
          (issue.description ?? '') + clarificationBlock;

        await this.prisma.issue.update({
          where: { id: issueId },
          data: { description: updatedDesc },
        });

        // Sync to GitLab
        if (issue.gitlabIid && issue.project.gitlabProjectId) {
          try {
            await this.gitlabService.updateIssue(
              issue.project.gitlabProjectId,
              issue.gitlabIid,
              { description: updatedDesc },
            );
          } catch (err) {
            this.logger.warn(
              `Failed to sync clarification to GitLab: ${err.message}`,
            );
          }
        }
      }
    }

    // Mark task as CANCELLED (will be re-triggered by orchestrator)
    await this.prisma.agentTask.update({
      where: { id: waitingTask.id },
      data: {
        status: AgentTaskStatus.CANCELLED,
        output: {
          clarificationAnswer: userAnswer,
          cancelledReason: 'Clarification received — pipeline will resume',
        } as any,
        completedAt: new Date(),
      },
    });

    await this.prisma.agentInstance.update({
      where: { id: waitingTask.agent.id },
      data: { status: AgentStatus.IDLE },
    });

    // Post confirmation message
    const confirmMsg = await this.chatService.addMessage({
      chatSessionId,
      role: 'SYSTEM' as any,
      content: `Clarification received. Resuming pipeline for ${this.formatRoleName(agentRole as AgentRole)}...`,
    });
    this.chatGateway.emitToSession(chatSessionId, 'newMessage', confirmMsg);

    return {
      handled: true,
      resumeAction: waitingTask.type,
      issueId: issueId ?? undefined,
    };
  }

  /**
   * Check if there's a task waiting for input in a given session.
   */
  async findWaitingTask(chatSessionId: string) {
    const session = await this.prisma.chatSession.findUnique({
      where: { id: chatSessionId },
      select: { projectId: true },
    });
    if (!session) return null;

    return this.prisma.agentTask.findFirst({
      where: {
        status: AgentTaskStatus.WAITING_FOR_INPUT,
        agent: { projectId: session.projectId },
      },
      include: {
        agent: { select: { role: true, id: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  private formatRoleName(role: AgentRole): string {
    const names: Record<string, string> = {
      INTERVIEWER: 'Interviewer',
      ARCHITECT: 'Architect',
      ISSUE_COMPILER: 'Issue Compiler',
      CODER: 'Coder',
      CODE_REVIEWER: 'Code Reviewer',
      FUNCTIONAL_TESTER: 'Functional Tester',
      UI_TESTER: 'UI Tester',
      PEN_TESTER: 'Pen Tester',
      DOCUMENTER: 'Documenter',
      DEVOPS: 'DevOps',
    };
    return names[role] ?? role;
  }
}
