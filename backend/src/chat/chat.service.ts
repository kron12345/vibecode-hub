import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateChatSessionDto, SendMessageDto } from './chat.dto';
import { ChatSessionType, SessionStatus } from '@prisma/client';

@Injectable()
export class ChatService {
  constructor(private prisma: PrismaService) {}

  // ─── Sessions ────────────────────────────────────────────────

  async findSessionsByProject(projectId: string, type?: ChatSessionType) {
    return this.prisma.chatSession.findMany({
      where: {
        projectId,
        ...(type && { type }),
      },
      orderBy: { updatedAt: 'desc' },
      include: {
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { content: true, role: true, createdAt: true },
        },
        _count: { select: { issues: true } },
      },
    });
  }

  async getArchivedSessions(projectId: string) {
    return this.prisma.chatSession.findMany({
      where: {
        projectId,
        type: ChatSessionType.DEV_SESSION,
        status: SessionStatus.ARCHIVED,
      },
      orderBy: { archivedAt: 'desc' },
      include: {
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { content: true, role: true, createdAt: true },
        },
        _count: { select: { issues: true } },
      },
    });
  }

  async findSessionById(id: string) {
    const session = await this.prisma.chatSession.findUnique({
      where: { id },
      include: {
        messages: { orderBy: { createdAt: 'asc' } },
        project: { select: { id: true, slug: true, name: true } },
      },
    });
    if (!session) throw new NotFoundException(`ChatSession "${id}" not found`);
    return session;
  }

  async createSession(dto: CreateChatSessionDto) {
    return this.prisma.chatSession.create({
      data: {
        projectId: dto.projectId,
        title: dto.title ?? 'New Chat',
      },
    });
  }

  async deleteSession(id: string) {
    return this.prisma.chatSession.delete({ where: { id } });
  }

  // ─── Messages ────────────────────────────────────────────────

  async getMessages(chatSessionId: string) {
    return this.prisma.chatMessage.findMany({
      where: { chatSessionId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async addMessage(
    dto: SendMessageDto & { metadata?: Record<string, unknown> },
  ) {
    const message = await this.prisma.chatMessage.create({
      data: {
        chatSessionId: dto.chatSessionId,
        role: dto.role,
        content: dto.content,
        issueId: dto.issueId,
        agentTaskId: dto.agentTaskId,
        ...(dto.metadata && { metadata: dto.metadata as any }),
      },
    });

    // Touch the session's updatedAt
    await this.prisma.chatSession.update({
      where: { id: dto.chatSessionId },
      data: { updatedAt: new Date() },
    });

    return message;
  }
}
