import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs/promises';
import { PrismaService } from '../../prisma/prisma.service';
import { SystemSettingsService } from '../../settings/system-settings.service';
import { ChatService } from '../../chat/chat.service';
import { ChatGateway } from '../../chat/chat.gateway';
import { LlmService } from '../../llm/llm.service';
import { GitlabService } from '../../gitlab/gitlab.service';
import { LlmMessage } from '../../llm/llm.interfaces';
import { BaseAgent, AgentContext } from '../agent-base';
import { postAgentComment, getAgentCommentHistory } from '../agent-comment.utils';
import { DocumenterResult, DocFile } from './documenter-result.interface';
import {
  AgentRole,
  AgentStatus,
  AgentTaskStatus,
  IssueStatus,
} from '@prisma/client';

const execFileAsync = promisify(execFile);

const COMPLETION_MARKER = ':::DOCS_COMPLETE:::';
const GIT_TIMEOUT_MS = 30_000;

const DEFAULT_SYSTEM_PROMPT = `You are the Documenter Agent for VibCode Hub — an AI development team platform.

## Your Role
You generate and update project documentation based on merge request changes.

## Documentation Types
- **README.md** — Project overview, installation, usage, API summary
- **API docs** — Endpoint documentation (if new API routes added)
- **JSDoc/TSDoc** — Inline code documentation for complex functions
- **CHANGELOG** — Summary of changes for the current version

## Guidelines
- Only update docs relevant to the actual code changes
- Keep documentation concise and accurate
- Use existing doc style and formatting conventions
- Don't duplicate information already in the code
- Include code examples where helpful

## Output Format
Provide the files to create or update as a JSON array.

## Completion Format
End your analysis with EXACTLY this format:

${COMPLETION_MARKER}
\`\`\`json
{
  "summary": "Updated README with new API endpoints and added JSDoc to service methods",
  "files": [
    {
      "path": "README.md",
      "content": "# Project Name\\n\\n...",
      "action": "update"
    },
    {
      "path": "docs/api.md",
      "content": "# API Documentation\\n\\n...",
      "action": "create"
    }
  ]
}
\`\`\`

CRITICAL: The JSON must be valid. Each file needs "path", "content", and "action" ("create" or "update").
IMPORTANT: "content" must be the COMPLETE file content, not a diff or partial update.`;

@Injectable()
export class DocumenterAgent extends BaseAgent {
  readonly role = AgentRole.DOCUMENTER;
  protected readonly logger = new Logger(DocumenterAgent.name);

  constructor(
    prisma: PrismaService,
    settings: SystemSettingsService,
    chatService: ChatService,
    chatGateway: ChatGateway,
    llmService: LlmService,
    private readonly gitlabService: GitlabService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    super(prisma, settings, chatService, chatGateway, llmService);
  }

  /**
   * Generate/update documentation for a merge request.
   */
  async documentIssue(
    ctx: AgentContext,
    issueId: string,
    mrIid: number,
    gitlabProjectId: number,
  ): Promise<void> {
    try {
      await this.updateStatus(ctx, AgentStatus.WORKING);

      // Load issue + project
      const issue = await this.prisma.issue.findUnique({
        where: { id: issueId },
        include: { project: true },
      });
      if (!issue) {
        await this.sendAgentMessage(ctx, `Issue ${issueId} not found`);
        await this.markFailed(ctx, 'Issue not found');
        return;
      }

      const project = issue.project;
      const workspace = path.resolve(this.settings.devopsWorkspacePath, project.slug);

      await this.sendAgentMessage(
        ctx,
        `**Documenter** updating docs for MR !${mrIid}, issue #${issue.gitlabIid ?? '?'}: **${issue.title}**`,
      );

      // Get MR diffs
      const diffs = await this.fetchDiffsWithRetry(gitlabProjectId, mrIid, 3, 5000);

      // Read existing docs from workspace
      const existingDocs = await this.readExistingDocs(workspace);

      // Determine the feature branch
      const branchName = `feature/${issue.gitlabIid ?? issue.id}-${this.slugify(issue.title)}`;

      // Ensure we're on the feature branch
      try {
        await execFileAsync('git', ['checkout', branchName], { cwd: workspace, timeout: GIT_TIMEOUT_MS });
      } catch {
        this.logger.warn(`Could not checkout ${branchName} — working on current branch`);
      }

      // Build LLM prompt
      const config = this.getRoleConfig();
      const systemPrompt = config.systemPrompt || DEFAULT_SYSTEM_PROMPT;

      const MAX_DIFFS = 20;
      const MAX_DIFF_CHARS = 2000;
      const reviewDiffs = diffs.slice(0, MAX_DIFFS);

      const diffText = reviewDiffs.map((d: any) => {
        const prefix = d.new_file ? '[NEW]' : d.deleted_file ? '[DELETED]' : '[MODIFIED]';
        const truncated = d.diff.length > MAX_DIFF_CHARS
          ? d.diff.substring(0, MAX_DIFF_CHARS) + '\n... (truncated)'
          : d.diff;
        return `### ${prefix} ${d.new_path}\n\`\`\`diff\n${truncated}\n\`\`\``;
      }).join('\n\n');

      const docsText = existingDocs.length > 0
        ? existingDocs.map(d => `### ${d.path}\n\`\`\`\n${d.content.substring(0, 3000)}\n\`\`\``).join('\n\n')
        : '_No existing documentation found._';

      // Inject previous agent comments as context
      const commentHistory = await getAgentCommentHistory({ prisma: this.prisma, issueId });
      const historySection = commentHistory
        ? `\n## Previous Agent Comments on this Issue\n${commentHistory}\n`
        : '';

      const userPrompt = `Generate or update documentation for this merge request:

**Issue:** ${issue.title}
**Description:** ${issue.description || 'N/A'}
${historySection}
## MR Diffs (${reviewDiffs.length} of ${diffs.length} file(s)):

${diffText || '_No diffs available._'}

## Existing Documentation:

${docsText}

Based on the code changes, create or update relevant documentation files.
For high-level documentation (project overview, getting started, architecture), set \`wikiPage: true\` in the file entry.
For code-level docs (README, API, JSDoc), keep \`wikiPage: false\` or omit it.`;

      const messages: LlmMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ];

      const result = await this.callLlm(messages);

      if (result.finishReason === 'error') {
        await this.sendAgentMessage(ctx, 'Documenter LLM call failed');
        await this.markFailed(ctx, 'LLM call failed');
        return;
      }

      // Parse result
      const docResult = this.parseDocResult(result.content, issueId);

      if (!docResult || docResult.files.length === 0) {
        await this.sendAgentMessage(ctx, 'No documentation changes needed');
        await this.handleComplete(ctx, issueId, mrIid, gitlabProjectId, {
          issueId, filesUpdated: [], summary: 'No documentation changes needed',
        });
        return;
      }

      // Write files to workspace
      const writtenFiles: string[] = [];
      for (const file of docResult.files) {
        try {
          const filePath = path.resolve(workspace, file.path);

          // Security: ensure path stays within workspace
          if (!filePath.startsWith(workspace)) {
            this.logger.warn(`Skipping file outside workspace: ${file.path}`);
            continue;
          }

          // Create parent directories
          await fs.mkdir(path.dirname(filePath), { recursive: true });
          await fs.writeFile(filePath, file.content, 'utf-8');
          writtenFiles.push(file.path);
          this.logger.log(`Wrote doc file: ${file.path} (${file.action})`);
        } catch (err) {
          this.logger.warn(`Failed to write ${file.path}: ${err.message}`);
        }
      }

      if (writtenFiles.length === 0) {
        await this.sendAgentMessage(ctx, 'No documentation files could be written');
        await this.handleComplete(ctx, issueId, mrIid, gitlabProjectId, {
          issueId, filesUpdated: [], summary: 'No files written',
        });
        return;
      }

      // Git commit + push
      let commitSha: string | undefined;
      try {
        commitSha = await this.gitCommitAndPush(
          workspace,
          branchName,
          `docs: update documentation for #${issue.gitlabIid ?? issueId}`,
        );
      } catch (err) {
        this.logger.warn(`Git commit/push failed: ${err.message}`);
      }

      // Sync wiki pages
      const wikiFiles = docResult.files.filter(f => f.wikiPage);
      const wikiPages: string[] = [];
      for (const wf of wikiFiles) {
        try {
          const title = wf.path.replace(/\.md$/i, '').replace(/\//g, '-');
          await this.gitlabService.upsertWikiPage(gitlabProjectId, title, wf.content);
          wikiPages.push(title);
          this.logger.log(`Wiki page synced: ${title}`);
        } catch (err) {
          this.logger.warn(`Wiki sync failed for ${wf.path}: ${err.message}`);
        }
      }

      // Post unified comment (same rich markdown for local + GitLab)
      const filesListText = writtenFiles.map(f => `- \`${f}\``).join('\n');
      const wikiNote = wikiPages.length > 0
        ? `\n\n### Wiki Pages Updated:\n${wikiPages.map(p => `- ${p}`).join('\n')}`
        : '';

      const docComment = [
        `## 📝 Documentation Updated`,
        '',
        docResult.summary,
        '',
        '### Files:',
        filesListText,
        commitSha ? `\nCommit: \`${commitSha.substring(0, 8)}\`` : '',
        wikiNote,
        '',
        '---',
        '_Updated by Documenter Agent_',
      ].filter(Boolean).join('\n');

      await postAgentComment({
        prisma: this.prisma,
        gitlabService: this.gitlabService,
        issueId,
        gitlabProjectId,
        issueIid: issue.gitlabIid!,
        agentTaskId: ctx.agentTaskId,
        authorName: 'Documenter',
        markdownContent: docComment,
      });

      await this.handleComplete(ctx, issueId, mrIid, gitlabProjectId, {
        issueId,
        filesUpdated: writtenFiles,
        summary: docResult.summary,
        commitSha,
      });

    } catch (err) {
      this.logger.error(`Documentation failed: ${err.message}`, err.stack);
      await this.sendAgentMessage(ctx, `**Documenter** error: ${err.message}`);
      await this.markFailed(ctx, err.message);
    }
  }

  // ─── Result Handler ──────────────────────────────────────

  private async handleComplete(
    ctx: AgentContext,
    issueId: string,
    mrIid: number,
    gitlabProjectId: number,
    result: DocumenterResult,
  ): Promise<void> {
    const filesText = result.filesUpdated.length > 0
      ? `Updated: ${result.filesUpdated.join(', ')}`
      : 'No files changed';

    await this.sendAgentMessage(
      ctx,
      `**Documentation complete** for MR !${mrIid}\n\n${result.summary}\n${filesText}`,
    );

    // Update issue → DONE
    const doneIssue = await this.prisma.issue.update({
      where: { id: issueId },
      data: { status: IssueStatus.DONE },
    });

    // Sync status label + close in GitLab
    if (doneIssue.gitlabIid) {
      await this.gitlabService.syncStatusLabel(gitlabProjectId, doneIssue.gitlabIid, 'DONE').catch(() => {});
    }

    await this.prisma.agentTask.update({
      where: { id: ctx.agentTaskId },
      data: {
        status: AgentTaskStatus.COMPLETED,
        output: result as any,
        completedAt: new Date(),
      },
    });

    await this.updateStatus(ctx, AgentStatus.IDLE);

    this.eventEmitter.emit('agent.docsComplete', {
      projectId: ctx.projectId,
      chatSessionId: ctx.chatSessionId,
      issueId,
      mrIid,
      gitlabProjectId,
    });
  }

  // ─── File System ──────────────────────────────────────────

  private async readExistingDocs(workspace: string): Promise<{ path: string; content: string }[]> {
    const docFiles: { path: string; content: string }[] = [];
    const candidates = ['README.md', 'docs/README.md', 'docs/api.md', 'docs/API.md', 'CHANGELOG.md'];

    for (const candidate of candidates) {
      try {
        const filePath = path.resolve(workspace, candidate);
        const content = await fs.readFile(filePath, 'utf-8');
        docFiles.push({ path: candidate, content });
      } catch {
        // File doesn't exist — skip
      }
    }

    return docFiles;
  }

  // ─── Git Operations ──────────────────────────────────────

  private async gitCommitAndPush(cwd: string, branch: string, message: string): Promise<string> {
    await execFileAsync('git', ['add', '.'], { cwd, timeout: GIT_TIMEOUT_MS });

    // Check if there are staged changes
    const { stdout: status } = await execFileAsync(
      'git', ['status', '--porcelain'],
      { cwd, timeout: GIT_TIMEOUT_MS },
    );

    if (!status.trim()) {
      this.logger.log('No changes to commit');
      return '';
    }

    await execFileAsync('git', ['commit', '-m', message], { cwd, timeout: GIT_TIMEOUT_MS });
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd, timeout: GIT_TIMEOUT_MS });
    const commitSha = stdout.trim();

    await execFileAsync(
      'git', ['push', '-u', 'origin', branch],
      { cwd, timeout: GIT_TIMEOUT_MS },
    );

    return commitSha;
  }

  // ─── Parsing ──────────────────────────────────────────────

  private parseDocResult(content: string, issueId: string): { summary: string; files: DocFile[] } | null {
    this.logger.debug(`Parsing documenter result (${content.length} chars)`);

    if (!content.trim()) return null;

    let cleaned = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

    const jsonStr = this.extractJson(cleaned);

    if (!jsonStr) {
      this.logger.warn('No JSON found in documenter result');
      return null;
    }

    try {
      const fixed = jsonStr
        .replace(/,\s*([}\]])/g, '$1')
        .replace(/[\x00-\x1F\x7F]/g, (ch) => ch === '\n' || ch === '\t' ? ch : ' ');

      const parsed = JSON.parse(fixed);
      const summary = parsed.summary || 'Documentation updated';
      const files: DocFile[] = (parsed.files || [])
        .filter((f: any) => f && f.path && f.content)
        .map((f: any) => ({
          path: String(f.path),
          content: String(f.content),
          action: f.action === 'create' ? 'create' : 'update',
          wikiPage: f.wikiPage === true,
        }));

      return { summary, files };

    } catch (err) {
      this.logger.error(`JSON parse failed: ${err.message}`);
      return null;
    }
  }

  private extractJson(content: string): string | null {
    if (content.includes(COMPLETION_MARKER)) {
      const after = content.substring(
        content.indexOf(COMPLETION_MARKER) + COMPLETION_MARKER.length,
      ).trim();
      const json = this.findJsonObject(after);
      if (json) return json;
    }

    const fenceMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (fenceMatch) {
      const json = this.findJsonObject(fenceMatch[1]);
      if (json) return json;
    }

    const greedy = content.match(/\{[\s\S]*"files"[\s\S]*\}/);
    if (greedy) return greedy[0];

    return null;
  }

  private findJsonObject(str: string): string | null {
    const stripped = str.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
    const match = stripped.match(/\{[\s\S]*\}/);
    return match ? match[0] : null;
  }

  private async fetchDiffsWithRetry(
    gitlabProjectId: number,
    mrIid: number,
    maxRetries: number,
    delayMs: number,
  ): Promise<any[]> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const diffs = await this.gitlabService.getMergeRequestDiffs(gitlabProjectId, mrIid);
      if (diffs.length > 0) return diffs;
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
    return [];
  }

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 40);
  }

  // ─── Helpers ──────────────────────────────────────────────

  private async markFailed(ctx: AgentContext, reason: string): Promise<void> {
    try {
      await this.prisma.agentTask.update({
        where: { id: ctx.agentTaskId },
        data: { status: AgentTaskStatus.FAILED, completedAt: new Date() },
      });
      await this.updateStatus(ctx, AgentStatus.ERROR);
      await this.log(ctx.agentTaskId, 'ERROR', `Documentation failed: ${reason}`);
    } catch (err) {
      this.logger.error(`Failed to mark task as failed: ${err.message}`);
    }
  }
}
