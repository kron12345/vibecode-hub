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
import { BaseAgent, AgentContext, KNOWLEDGE_BASE_FILE } from '../agent-base';
import { MonitorGateway } from '../../monitor/monitor.gateway';
import { DualTestService } from '../dual-test.service';
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
You MUST update these files after EVERY issue:

### Mandatory Updates
1. **${KNOWLEDGE_BASE_FILE}** — Project Knowledge Base. Add the completed feature to "Implemented Features", update "Architecture & Patterns" and "Key Files" if new patterns/files were introduced. Keep all existing content, only ADD new information.
2. **CHANGELOG.md** — Add a new entry under "[Unreleased] > Added/Changed/Fixed" describing what this issue implemented.
3. **README.md** — Update if the feature changes installation, usage, or API surface.

### Optional Updates
- **API docs** — If new API routes were added
- **JSDoc/TSDoc** — For complex functions introduced

## Guidelines
- ALWAYS update ${KNOWLEDGE_BASE_FILE} and CHANGELOG.md — these are mandatory
- Keep documentation concise and accurate
- Use existing doc style and formatting conventions
- README.md: Include installation steps, project description, feature list, usage examples
- CHANGELOG.md: Follow Keep a Changelog format (Added/Changed/Fixed/Removed)
- ${KNOWLEDGE_BASE_FILE}: Accumulate knowledge — never remove existing entries, only add

## Output Format
Provide the files to create or update as a JSON array.

## Completion Format
End your analysis with EXACTLY this format:

${COMPLETION_MARKER}
\`\`\`json
{
  "summary": "Updated Knowledge Base, CHANGELOG, and README with new feature",
  "files": [
    {
      "path": "${KNOWLEDGE_BASE_FILE}",
      "content": "# Project Knowledge Base...full content...",
      "action": "update"
    },
    {
      "path": "CHANGELOG.md",
      "content": "# Changelog...full content...",
      "action": "update"
    }
  ]
}
\`\`\`

CRITICAL: The JSON must be valid. Each file needs "path", "content", and "action" ("create" or "update").
IMPORTANT: "content" must be the COMPLETE file content, not a diff or partial update.
IMPORTANT: ALWAYS include ${KNOWLEDGE_BASE_FILE} and CHANGELOG.md in your output files.`;

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
    monitorGateway: MonitorGateway,
    private readonly eventEmitter: EventEmitter2,
    private readonly dualTestService: DualTestService,
  ) {
    super(prisma, settings, chatService, chatGateway, llmService, monitorGateway);
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
      const docResult = await this.parseDocResult(result.content, issueId);

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
    const candidates = [KNOWLEDGE_BASE_FILE, 'README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'docs/README.md', 'docs/api.md', 'docs/API.md'];

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

  private async parseDocResult(
    content: string,
    issueId: string,
  ): Promise<{ summary: string; files: DocFile[] } | null> {
    this.logger.debug(`Parsing documenter result (${content.length} chars)`);

    if (!content.trim()) return null;

    const cleaned = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

    // Strategy 1: Extract JSON via balanced brackets
    const jsonStr = this.extractJson(cleaned);
    if (jsonStr) {
      const parsed = this.tryParseDocJson(jsonStr);
      if (parsed) return parsed;
    }

    // Strategy 2: Escape unescaped newlines inside JSON string values and retry
    if (jsonStr) {
      const repaired = this.repairJsonStringValues(jsonStr);
      const parsed = this.tryParseDocJson(repaired);
      if (parsed) {
        this.logger.log('JSON parse succeeded after string-value repair');
        return parsed;
      }
    }

    // Strategy 3: DualTestService retry — ask LLM to re-extract as clean JSON
    if (cleaned.length > 200) {
      this.logger.log('Attempting JSON retry via DualTestService');
      const config = this.getRoleConfig();
      const retryJson = await this.dualTestService.retryJsonExtraction(
        config,
        cleaned,
        '{"summary": "1-2 sentence summary", "files": [{"path": "relative/file.md", "content": "full file content", "action": "create|update", "wikiPage": true|false}]}',
      );
      if (retryJson) {
        const parsed = this.tryParseDocJson(retryJson);
        if (parsed) {
          this.logger.log(`JSON retry recovered ${parsed.files.length} doc files`);
          return parsed;
        }
      }
    }

    // Strategy 4: Text fallback — extract documentation from markdown blocks
    const fallback = this.textFallbackParse(cleaned);
    if (fallback && fallback.files.length > 0) {
      this.logger.log(`Text fallback extracted ${fallback.files.length} doc files`);
      return fallback;
    }

    this.logger.warn('All parsing strategies failed for documenter result');
    return null;
  }

  /**
   * Try parsing a JSON string into a DocResult, with common fixups.
   */
  private tryParseDocJson(jsonStr: string): { summary: string; files: DocFile[] } | null {
    try {
      const fixed = jsonStr
        .replace(/,\s*([}\]])/g, '$1')                       // trailing commas
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' '); // control chars (keep \n \r \t)

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

      if (files.length === 0) return null;
      return { summary, files };
    } catch {
      return null;
    }
  }

  /**
   * Repair unescaped newlines, tabs, and backslashes inside JSON string values.
   * The LLM often puts literal newlines in the "content" field instead of \\n.
   */
  private repairJsonStringValues(json: string): string {
    // Walk the string, tracking whether we're inside a JSON string value.
    // Inside a string, replace literal newlines with \\n.
    const chars: string[] = [];
    let inString = false;
    let escaped = false;

    for (let i = 0; i < json.length; i++) {
      const ch = json[i];

      if (escaped) {
        chars.push(ch);
        escaped = false;
        continue;
      }

      if (ch === '\\' && inString) {
        chars.push(ch);
        escaped = true;
        continue;
      }

      if (ch === '"') {
        inString = !inString;
        chars.push(ch);
        continue;
      }

      if (inString && ch === '\n') {
        chars.push('\\', 'n');
        continue;
      }
      if (inString && ch === '\r') {
        chars.push('\\', 'r');
        continue;
      }
      if (inString && ch === '\t') {
        chars.push('\\', 't');
        continue;
      }

      chars.push(ch);
    }

    return chars.join('');
  }

  /**
   * Extract JSON using balanced bracket matching.
   * Handles nested code fences in string values that break regex approaches.
   */
  private extractJson(content: string): string | null {
    // Strategy A: Look for completion marker first
    if (content.includes(COMPLETION_MARKER)) {
      const after = content.substring(
        content.indexOf(COMPLETION_MARKER) + COMPLETION_MARKER.length,
      ).trim();
      const json = this.extractBalancedJson(after);
      if (json) return json;
    }

    // Strategy B: Find the LAST top-level JSON object containing "files"
    // (the last one is most likely the actual result, not embedded code)
    const candidates = this.findAllBalancedJsonObjects(content);
    // Prefer objects that have both "summary" and "files" keys
    for (let i = candidates.length - 1; i >= 0; i--) {
      if (candidates[i].includes('"files"') && candidates[i].includes('"summary"')) {
        return candidates[i];
      }
    }
    // Fallback: any object with "files"
    for (let i = candidates.length - 1; i >= 0; i--) {
      if (candidates[i].includes('"files"')) {
        return candidates[i];
      }
    }

    return null;
  }

  /**
   * Extract the first balanced JSON object from a string using bracket counting.
   */
  private extractBalancedJson(str: string): string | null {
    const start = str.indexOf('{');
    if (start === -1) return null;
    return this.matchBalancedBraces(str, start);
  }

  /**
   * Find ALL top-level balanced JSON objects in a string.
   */
  private findAllBalancedJsonObjects(str: string): string[] {
    const results: string[] = [];
    let pos = 0;
    while (pos < str.length) {
      const start = str.indexOf('{', pos);
      if (start === -1) break;
      const obj = this.matchBalancedBraces(str, start);
      if (obj) {
        results.push(obj);
        pos = start + obj.length;
      } else {
        pos = start + 1;
      }
    }
    return results;
  }

  /**
   * From position `start` (which must be '{'), match balanced braces,
   * correctly skipping over JSON string values (including escaped quotes).
   */
  private matchBalancedBraces(str: string, start: number): string | null {
    if (str[start] !== '{') return null;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < str.length; i++) {
      const ch = str[i];

      if (escaped) {
        escaped = false;
        continue;
      }

      if (ch === '\\' && inString) {
        escaped = true;
        continue;
      }

      if (ch === '"') {
        inString = !inString;
        continue;
      }

      if (!inString) {
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) {
            return str.substring(start, i + 1);
          }
        }
      }
    }

    // Unbalanced — return null
    return null;
  }

  /**
   * Text fallback: when JSON extraction fails entirely, look for markdown-formatted
   * documentation blocks and extract them as files.
   */
  private textFallbackParse(content: string): { summary: string; files: DocFile[] } | null {
    const files: DocFile[] = [];

    // Look for patterns like "### README.md" or "## docs/api.md" followed by code fences
    const fileBlockRegex = /#{2,4}\s+(`?([a-zA-Z0-9_\-./]+\.(?:md|txt|json|yaml|yml))`?)\s*\n+```(?:\w*)\s*\n([\s\S]*?)\n```/g;
    let match: RegExpExecArray | null;

    while ((match = fileBlockRegex.exec(content)) !== null) {
      const filePath = match[2].trim();
      const fileContent = match[3].trim();
      if (filePath && fileContent && fileContent.length > 10) {
        files.push({
          path: filePath,
          content: fileContent,
          action: 'update',
          wikiPage: false,
        });
      }
    }

    // Also look for standalone README.md / CHANGELOG.md blocks
    if (files.length === 0) {
      const readmeMatch = content.match(/(?:^|\n)(# [^\n]+\n[\s\S]{50,})/);
      if (readmeMatch) {
        files.push({
          path: 'README.md',
          content: readmeMatch[1].trim(),
          action: 'update',
          wikiPage: false,
        });
      }
    }

    if (files.length === 0) return null;

    // Extract a summary sentence
    const summaryMatch = content.match(/(?:summary|documentation)[:\s]*([^\n]{10,100})/i);
    const summary = summaryMatch
      ? summaryMatch[1].trim()
      : `Documentation updated (${files.length} file(s) extracted from text fallback)`;

    return { summary, files };
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
