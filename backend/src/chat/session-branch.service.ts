import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs/promises';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../settings/system-settings.service';
import { GitlabService } from '../gitlab/gitlab.service';
import { ChatService } from './chat.service';
import { ChatGateway } from './chat.gateway';
import { getSessionWorktreePath } from '../agents/agent-base';
import {
  ChatSessionType,
  SessionStatus,
  IssueStatus,
  MessageRole,
  ProjectStatus,
} from '@prisma/client';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 60_000;

export interface ArchiveResult {
  success: boolean;
  merged: boolean;
  conflicts?: string[];
  error?: string;
}

@Injectable()
export class SessionBranchService {
  private readonly logger = new Logger(SessionBranchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SystemSettingsService,
    private readonly gitlabService: GitlabService,
    private readonly chatService: ChatService,
    private readonly chatGateway: ChatGateway,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ─── Create Dev Session ───────────────────────────────────

  async createDevSession(
    projectId: string,
    title?: string,
    branchName?: string,
  ) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
    });
    if (!project) throw new BadRequestException('Project not found');

    const sessionTitle = title || 'New Session';
    const slug = this.slugify(sessionTitle);
    const shortId = Math.random().toString(36).substring(2, 8);
    const branch = branchName || `session/${slug}-${shortId}`;

    // Create git worktree for the session branch
    if (project.gitlabProjectId) {
      const mainWorkspace = path.resolve(
        this.settings.devopsWorkspacePath,
        project.slug,
      );
      const baseBranch = project.workBranch || 'main';
      const worktreePath = getSessionWorktreePath(
        this.settings.devopsWorkspacePath,
        project.slug,
        branch,
      );

      try {
        // Ensure worktree parent directory exists
        await fs.mkdir(path.dirname(worktreePath), { recursive: true });

        // Ensure main workspace is up to date
        await execFileAsync('git', ['checkout', baseBranch], {
          cwd: mainWorkspace,
          timeout: GIT_TIMEOUT_MS,
        });
        await execFileAsync('git', ['pull', '--ff-only'], {
          cwd: mainWorkspace,
          timeout: GIT_TIMEOUT_MS,
        });

        // Create session branch from base
        await execFileAsync('git', ['branch', branch, baseBranch], {
          cwd: mainWorkspace,
          timeout: GIT_TIMEOUT_MS,
        });

        // Create worktree for the session branch
        await execFileAsync('git', ['worktree', 'add', worktreePath, branch], {
          cwd: mainWorkspace,
          timeout: GIT_TIMEOUT_MS,
        });

        // Push session branch to origin from the worktree
        await execFileAsync('git', ['push', '-u', 'origin', branch], {
          cwd: worktreePath,
          timeout: GIT_TIMEOUT_MS,
        });

        this.logger.log(
          `Created worktree at ${worktreePath} on branch ${branch} from ${baseBranch}`,
        );
      } catch (err) {
        this.logger.error(
          `Failed to create worktree for branch ${branch}: ${err.message}`,
        );
        // Cleanup: try to remove worktree if it was partially created
        try {
          await execFileAsync(
            'git',
            ['worktree', 'remove', '--force', worktreePath],
            {
              cwd: mainWorkspace,
              timeout: GIT_TIMEOUT_MS,
            },
          );
        } catch {
          /* best effort */
        }
        try {
          await execFileAsync('git', ['branch', '-D', branch], {
            cwd: mainWorkspace,
            timeout: GIT_TIMEOUT_MS,
          });
        } catch {
          /* best effort */
        }
        throw new BadRequestException(
          `Git worktree creation failed: ${err.message}`,
        );
      }
    }

    // Create ChatSession
    const session = await this.prisma.chatSession.create({
      data: {
        projectId,
        title: sessionTitle,
        type: ChatSessionType.DEV_SESSION,
        status: SessionStatus.ACTIVE,
        branch,
      },
    });

    // Post system message
    await this.chatService.addMessage({
      chatSessionId: session.id,
      role: MessageRole.SYSTEM,
      content: `🚀 Dev session started — Branch: \`${branch}\``,
    });

    // Auto-start feature interview if project is READY
    if (project.status === ProjectStatus.READY) {
      this.eventEmitter.emit('session.devSessionCreated', {
        projectId,
        chatSessionId: session.id,
        sessionTitle: sessionTitle,
      });
    }

    return session;
  }

  // ─── Archive Session (Merge → main) ──────────────────────

  async archiveSession(sessionId: string): Promise<ArchiveResult> {
    const session = await this.prisma.chatSession.findUnique({
      where: { id: sessionId },
      include: {
        project: true,
        issues: { where: { parentId: null } },
      },
    });

    if (!session) throw new BadRequestException('Session not found');
    if (session.type !== ChatSessionType.DEV_SESSION) {
      throw new BadRequestException('Only dev sessions can be archived');
    }
    if (session.status === SessionStatus.ARCHIVED) {
      throw new BadRequestException('Session is already archived');
    }

    // Update status to MERGING
    await this.prisma.chatSession.update({
      where: { id: sessionId },
      data: { status: SessionStatus.MERGING },
    });

    // Collect open issues (closed AFTER successful merge, not before)
    const openIssues = session.issues.filter(
      (i) => i.status !== IssueStatus.DONE && i.status !== IssueStatus.CLOSED,
    );

    // Merge branch if project has GitLab
    if (session.project.gitlabProjectId && session.branch) {
      const mainWorkspace = path.resolve(
        this.settings.devopsWorkspacePath,
        session.project.slug,
      );
      const baseBranch = session.project.workBranch || 'main';
      const worktreePath = getSessionWorktreePath(
        this.settings.devopsWorkspacePath,
        session.project.slug,
        session.branch,
      );

      try {
        // Remove worktree first (frees the branch for merging)
        try {
          await execFileAsync(
            'git',
            ['worktree', 'remove', '--force', worktreePath],
            {
              cwd: mainWorkspace,
              timeout: GIT_TIMEOUT_MS,
            },
          );
        } catch {
          // Worktree may not exist (e.g. project without GitLab at creation time)
        }

        // Checkout base, pull, merge session branch in main workspace
        await execFileAsync('git', ['checkout', baseBranch], {
          cwd: mainWorkspace,
          timeout: GIT_TIMEOUT_MS,
        });
        await execFileAsync('git', ['pull', '--ff-only'], {
          cwd: mainWorkspace,
          timeout: GIT_TIMEOUT_MS,
        });
        await execFileAsync(
          'git',
          [
            'merge',
            '--no-ff',
            session.branch,
            '-m',
            `Merge session: ${session.title}`,
          ],
          { cwd: mainWorkspace, timeout: GIT_TIMEOUT_MS },
        );
        await execFileAsync('git', ['push'], {
          cwd: mainWorkspace,
          timeout: GIT_TIMEOUT_MS,
        });

        // Delete remote branch
        try {
          await execFileAsync(
            'git',
            ['push', 'origin', '--delete', session.branch],
            { cwd: mainWorkspace, timeout: GIT_TIMEOUT_MS },
          );
        } catch {
          // Non-critical
        }

        // Delete local branch
        try {
          await execFileAsync('git', ['branch', '-d', session.branch], {
            cwd: mainWorkspace,
            timeout: GIT_TIMEOUT_MS,
          });
        } catch {
          // Non-critical
        }

        this.logger.log(
          `Session ${sessionId} merged into ${baseBranch} and branch ${session.branch} deleted`,
        );
      } catch (err) {
        const errMsg = [err.message, err.stdout, err.stderr]
          .filter(Boolean)
          .join(' ');
        if (errMsg.includes('CONFLICT') || errMsg.includes('conflict')) {
          // Merge conflict
          await this.prisma.chatSession.update({
            where: { id: sessionId },
            data: { status: SessionStatus.CONFLICT },
          });

          // Abort the failed merge
          try {
            await execFileAsync('git', ['merge', '--abort'], {
              cwd: mainWorkspace,
              timeout: GIT_TIMEOUT_MS,
            });
          } catch {
            // best effort
          }

          return {
            success: false,
            merged: false,
            conflicts: [errMsg],
            error: 'Merge conflict detected',
          };
        }

        // Other git error
        await this.prisma.chatSession.update({
          where: { id: sessionId },
          data: { status: SessionStatus.ACTIVE },
        });
        return { success: false, merged: false, error: err.message };
      }
    }

    // Close open issues AFTER successful merge
    if (openIssues.length > 0) {
      await this.prisma.issue.updateMany({
        where: {
          id: { in: openIssues.map((i) => i.id) },
        },
        data: { status: IssueStatus.CLOSED },
      });
    }

    // Mark as archived
    await this.prisma.chatSession.update({
      where: { id: sessionId },
      data: {
        status: SessionStatus.ARCHIVED,
        archivedAt: new Date(),
      },
    });

    // Post system message
    await this.chatService.addMessage({
      chatSessionId: sessionId,
      role: MessageRole.SYSTEM,
      content: `📦 Session archived and merged into main.`,
    });

    return { success: true, merged: true };
  }

  // ─── Continue Archived Session ────────────────────────────

  async continueSession(archivedSessionId: string) {
    const archived = await this.prisma.chatSession.findUnique({
      where: { id: archivedSessionId },
    });

    if (!archived) throw new BadRequestException('Session not found');
    if (archived.status !== SessionStatus.ARCHIVED) {
      throw new BadRequestException('Only archived sessions can be continued');
    }

    // Create new session with parentId
    const newSession = await this.createDevSession(
      archived.projectId,
      `${archived.title} (continued)`,
    );

    // Link to parent
    await this.prisma.chatSession.update({
      where: { id: newSession.id },
      data: { parentId: archivedSessionId },
    });

    return newSession;
  }

  // ─── Resolve Merge Conflict ───────────────────────────────

  async resolveConflict(sessionId: string): Promise<ArchiveResult> {
    const session = await this.prisma.chatSession.findUnique({
      where: { id: sessionId },
      include: { project: true },
    });

    if (!session) throw new BadRequestException('Session not found');
    if (session.status !== SessionStatus.CONFLICT) {
      throw new BadRequestException('Session has no conflict to resolve');
    }

    // For now: retry the merge (user or Coder Agent should have resolved conflicts)
    await this.prisma.chatSession.update({
      where: { id: sessionId },
      data: { status: SessionStatus.MERGING },
    });

    return this.archiveSession(sessionId);
  }

  // ─── Update Session Title/Branch ──────────────────────────

  async updateSession(sessionId: string, data: { title?: string }) {
    return this.prisma.chatSession.update({
      where: { id: sessionId },
      data: {
        ...(data.title && { title: data.title }),
      },
    });
  }

  // ─── Utility ──────────────────────────────────────────────

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .substring(0, 40);
  }
}
