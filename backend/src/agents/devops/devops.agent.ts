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
import { BaseAgent, AgentContext } from '../agent-base';
import { InterviewResult } from '../interviewer/interview-result.interface';
import {
  DevopsSetupResult,
  SetupStep,
  CommandResult,
} from './devops-result.interface';
import {
  AgentRole,
  AgentStatus,
  AgentTaskStatus,
  ProjectStatus,
} from '@prisma/client';

const execFileAsync = promisify(execFile);

/** Binaries allowed to be executed by the DevOps agent */
const ALLOWED_BINARIES = new Set([
  'npx', 'npm', 'node', 'git', 'pnpm', 'yarn', 'bun',
  'cargo', 'go', 'python', 'python3', 'pip', 'pip3',
  'dotnet', 'mvn', 'gradle',
]);

/** Known MCP server definitions — maps name → command + args */
const MCP_SERVER_REGISTRY: Record<string, { command: string; args: string[] }> = {
  'angular-mcp-server': { command: 'angular-mcp-server', args: [] },
  'prisma': { command: 'npx', args: ['prisma', 'mcp'] },
  'context7': { command: 'npx', args: ['-y', '@upstash/context7-mcp@latest'] },
  'typescript': { command: 'npx', args: ['-y', 'typescript-mcp-server'] },
  'eslint': { command: 'npx', args: ['-y', 'eslint-mcp-server'] },
  'tailwindcss': { command: 'npx', args: ['-y', '@anthropic/tailwindcss-mcp'] },
};

/** Timeout constants (milliseconds) */
const TIMEOUT_CLONE = 120_000;
const TIMEOUT_COMMAND = 300_000;
const TIMEOUT_PUSH = 120_000;

@Injectable()
export class DevopsAgent extends BaseAgent {
  readonly role = AgentRole.DEVOPS;
  protected readonly logger = new Logger(DevopsAgent.name);

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
   * Run the full project setup pipeline.
   * Deterministic — no LLM calls, but uses BaseAgent for status/logging/chat.
   */
  async runSetup(ctx: AgentContext): Promise<void> {
    const result: DevopsSetupResult = {
      workspacePath: '',
      cloneSuccess: false,
      initCommandResult: null,
      additionalCommandResults: [],
      mcpConfigGenerated: false,
      gitPushSuccess: false,
      webhookConfigured: false,
      steps: [],
    };

    try {
      await this.updateStatus(ctx, AgentStatus.WORKING);
      await this.sendAgentMessage(ctx, '🔧 **DevOps Agent** starting project setup...');

      // Step 1: Load project data
      const projectData = await this.stepLoadProject(ctx, result);
      if (!projectData) return; // Fatal — already handled

      const { project, interviewResult, gitlabProject } = projectData;

      // Step 2: Prepare workspace
      const projectDir = await this.stepPrepareWorkspace(ctx, result, project.slug);
      if (!projectDir) return; // Fatal

      result.workspacePath = projectDir;

      // Step 3: Clone repository
      const cloneSuccess = await this.stepCloneRepository(
        ctx, result, projectDir,
        gitlabProject.path_with_namespace,
        gitlabProject.default_branch,
      );
      if (!cloneSuccess) return; // Fatal

      // Step 4: Run init command
      await this.stepRunInitCommand(ctx, result, projectDir, interviewResult);

      // Step 5: Run additional commands
      await this.stepRunAdditionalCommands(ctx, result, projectDir, interviewResult);

      // Step 6: Generate .mcp.json
      await this.stepGenerateMcpConfig(ctx, result, projectDir, interviewResult);

      // Step 6b: Generate .gitlab-ci.yml
      await this.stepGenerateCiConfig(ctx, result, projectDir, interviewResult);

      // Step 7: Git commit & push
      await this.stepGitCommitAndPush(
        ctx, result, projectDir, gitlabProject.default_branch,
      );

      // Step 8: Finalize
      await this.stepFinalize(ctx, result);

    } catch (err) {
      this.logger.error(`DevOps setup crashed: ${err.message}`, err.stack);
      await this.sendAgentMessage(
        ctx,
        `❌ **DevOps Agent** encountered an unexpected error: ${err.message}`,
      );
      await this.markFailed(ctx, result, `Unexpected error: ${err.message}`);
    }
  }

  // ─── Step 1: Load Project Data ──────────────────────────────

  private async stepLoadProject(
    ctx: AgentContext,
    result: DevopsSetupResult,
  ) {
    const start = Date.now();
    try {
      let project = await this.prisma.project.findUnique({
        where: { id: ctx.projectId },
      });
      if (!project) throw new Error('Project not found');

      const interviewResult = project.techStack as unknown as InterviewResult;
      if (!interviewResult?.techStack) {
        throw new Error('No interview result / techStack on project');
      }

      // Auto-create GitLab repo if not linked yet (Quick-Create flow)
      if (!project.gitlabProjectId) {
        await this.sendAgentMessage(ctx, '📦 Creating GitLab repository...');
        const glProject = await this.gitlabService.createProject({
          name: project.name,
          path: project.slug,
          description: interviewResult.description || project.name,
        });
        project = await this.prisma.project.update({
          where: { id: ctx.projectId },
          data: {
            gitlabProjectId: glProject.id,
            gitlabUrl: glProject.web_url,
          },
        });
        this.logger.log(`GitLab repo created by DevOps agent: ${glProject.web_url}`);

        // Auto-add owner as Maintainer
        const ownerUserId = this.settings.gitlabOwnerUserId;
        if (ownerUserId) {
          try {
            await this.gitlabService.addProjectMember(glProject.id, ownerUserId, 40);
          } catch (err) {
            this.logger.warn(`Could not auto-add owner to GitLab project: ${err.message}`);
          }
        }
      }

      const gitlabProject = await this.gitlabService.getProject(
        project.gitlabProjectId!,
      );

      result.steps.push(this.step('loadProjectData', 'success', 'Project data loaded', start));
      return { project, interviewResult, gitlabProject };

    } catch (err) {
      result.steps.push(this.step('loadProjectData', 'failed', err.message, start));
      await this.sendAgentMessage(ctx, `❌ Failed to load project data: ${err.message}`);
      await this.markFailed(ctx, result, err.message);
      return null;
    }
  }

  // ─── Step 2: Prepare Workspace ──────────────────────────────

  private async stepPrepareWorkspace(
    ctx: AgentContext,
    result: DevopsSetupResult,
    slug: string,
  ): Promise<string | null> {
    const start = Date.now();
    try {
      const basePath = path.resolve(this.settings.devopsWorkspacePath);
      const projectDir = path.resolve(basePath, slug);

      // Path traversal check
      if (!projectDir.startsWith(basePath)) {
        throw new Error('Path traversal detected — slug produces invalid path');
      }

      await execFileAsync('mkdir', ['-p', projectDir], { timeout: 10_000 });
      await this.log(ctx.agentTaskId, 'INFO', `Workspace: ${projectDir}`);

      result.steps.push(this.step('prepareWorkspace', 'success', `Directory: ${projectDir}`, start));
      return projectDir;

    } catch (err) {
      result.steps.push(this.step('prepareWorkspace', 'failed', err.message, start));
      await this.sendAgentMessage(ctx, `❌ Failed to prepare workspace: ${err.message}`);
      await this.markFailed(ctx, result, err.message);
      return null;
    }
  }

  // ─── Step 3: Clone Repository ───────────────────────────────

  private async stepCloneRepository(
    ctx: AgentContext,
    result: DevopsSetupResult,
    projectDir: string,
    pathWithNamespace: string,
    defaultBranch: string,
  ): Promise<boolean> {
    const start = Date.now();
    try {
      const gitlabUrl = new URL(this.settings.gitlabUrl);
      const token = this.settings.gitlabToken;
      const cloneUrl = `https://hub-bot:${token}@${gitlabUrl.host}/${pathWithNamespace}.git`;
      const redactedUrl = `https://hub-bot:<redacted>@${gitlabUrl.host}/${pathWithNamespace}.git`;

      // Check if already cloned
      const gitDir = path.join(projectDir, '.git');
      let alreadyCloned = false;
      try {
        await fs.access(gitDir);
        alreadyCloned = true;
      } catch {
        // Not cloned yet
      }

      if (alreadyCloned) {
        // Remove stale workspace and re-clone to avoid merge conflicts
        await this.sendAgentMessage(ctx, `📂 Stale workspace found — re-cloning fresh...`);
        await execFileAsync('rm', ['-rf', projectDir], { timeout: 30_000 });
        await execFileAsync('mkdir', ['-p', projectDir], { timeout: 10_000 });
        await execFileAsync('git', ['clone', cloneUrl, '.'], {
          cwd: projectDir,
          timeout: TIMEOUT_CLONE,
        });
        await this.log(ctx.agentTaskId, 'INFO', `Re-cloned fresh: ${redactedUrl}`);
      } else {
        await this.sendAgentMessage(ctx, `📥 Cloning repository from GitLab...`);
        // Clone into the project directory (which was just created and is empty)
        await execFileAsync('git', ['clone', cloneUrl, '.'], {
          cwd: projectDir,
          timeout: TIMEOUT_CLONE,
        });
        await this.log(ctx.agentTaskId, 'INFO', `Git clone completed: ${redactedUrl}`);
      }

      result.cloneSuccess = true;
      result.steps.push(this.step(
        'cloneRepository', 'success',
        alreadyCloned ? 'Pulled latest changes' : 'Cloned successfully',
        start,
      ));
      return true;

    } catch (err) {
      result.cloneSuccess = false;
      result.steps.push(this.step('cloneRepository', 'failed', err.message, start));
      await this.sendAgentMessage(ctx, `❌ Git clone failed: ${err.message}`);
      await this.markFailed(ctx, result, `Clone failed: ${err.message}`);
      return false;
    }
  }

  // ─── Step 4: Run Init Command ──────────────────────────────

  private async stepRunInitCommand(
    ctx: AgentContext,
    result: DevopsSetupResult,
    projectDir: string,
    interviewResult: InterviewResult,
  ): Promise<void> {
    const start = Date.now();
    const initCommand = interviewResult.setupInstructions?.initCommand;

    if (!initCommand) {
      result.steps.push(this.step('runInitCommand', 'skipped', 'No init command specified', start));
      return;
    }

    try {
      await this.sendAgentMessage(ctx, `⚙️ Running init command: \`${initCommand}\``);
      const cmdResult = await this.executeCommand(initCommand, projectDir, TIMEOUT_COMMAND);
      result.initCommandResult = cmdResult;

      if (cmdResult.exitCode !== 0) {
        throw new Error(`Exit code ${cmdResult.exitCode}: ${cmdResult.stderr.slice(0, 500)}`);
      }

      result.steps.push(this.step('runInitCommand', 'success', 'Init command completed', start));
      await this.log(ctx.agentTaskId, 'INFO', `Init command OK: ${initCommand}`);

    } catch (err) {
      result.steps.push(this.step('runInitCommand', 'failed', err.message, start));
      await this.sendAgentMessage(ctx, `⚠️ Init command failed (non-fatal): ${err.message}`);
      await this.log(ctx.agentTaskId, 'WARN', `Init command failed: ${err.message}`);
    }
  }

  // ─── Step 5: Run Additional Commands ────────────────────────

  private async stepRunAdditionalCommands(
    ctx: AgentContext,
    result: DevopsSetupResult,
    projectDir: string,
    interviewResult: InterviewResult,
  ): Promise<void> {
    const start = Date.now();
    const commands = interviewResult.setupInstructions?.additionalCommands;

    if (!commands || commands.length === 0) {
      result.steps.push(this.step('runAdditionalCommands', 'skipped', 'No additional commands', start));
      return;
    }

    let allOk = true;
    for (const cmd of commands) {
      try {
        await this.sendAgentMessage(ctx, `⚙️ Running: \`${cmd}\``);
        const cmdResult = await this.executeCommand(cmd, projectDir, TIMEOUT_COMMAND);
        result.additionalCommandResults.push(cmdResult);

        if (cmdResult.exitCode !== 0) {
          throw new Error(`Exit code ${cmdResult.exitCode}: ${cmdResult.stderr.slice(0, 500)}`);
        }

        await this.log(ctx.agentTaskId, 'INFO', `Additional command OK: ${cmd}`);
      } catch (err) {
        allOk = false;
        await this.sendAgentMessage(ctx, `⚠️ Command failed (non-fatal): \`${cmd}\` — ${err.message}`);
        await this.log(ctx.agentTaskId, 'WARN', `Additional command failed: ${cmd}`, { error: err.message });
      }
    }

    result.steps.push(this.step(
      'runAdditionalCommands',
      allOk ? 'success' : 'failed',
      allOk ? `${commands.length} commands completed` : 'Some commands failed',
      start,
    ));
  }

  // ─── Step 6: Generate .mcp.json ────────────────────────────

  private async stepGenerateMcpConfig(
    ctx: AgentContext,
    result: DevopsSetupResult,
    projectDir: string,
    interviewResult: InterviewResult,
  ): Promise<void> {
    const start = Date.now();
    const mcpServers = interviewResult.mcpServers;

    if (!mcpServers || mcpServers.length === 0) {
      result.steps.push(this.step('generateMcpConfig', 'skipped', 'No MCP servers defined', start));
      return;
    }

    try {
      const mcpConfig: Record<string, { command: string; args: string[] }> = {};

      for (const server of mcpServers) {
        const known = MCP_SERVER_REGISTRY[server.name];
        if (known) {
          mcpConfig[server.name] = known;
        } else {
          // Unknown server — create a npx-based entry
          mcpConfig[server.name] = {
            command: 'npx',
            args: ['-y', server.name],
          };
          await this.log(ctx.agentTaskId, 'INFO', `Unknown MCP server "${server.name}" — using npx fallback`);
        }
      }

      const mcpJson = JSON.stringify({ mcpServers: mcpConfig }, null, 2);
      const mcpPath = path.join(projectDir, '.mcp.json');
      await fs.writeFile(mcpPath, mcpJson + '\n', 'utf-8');

      result.mcpConfigGenerated = true;
      result.steps.push(this.step('generateMcpConfig', 'success', `${mcpServers.length} MCP servers configured`, start));
      await this.sendAgentMessage(ctx, `📋 Generated \`.mcp.json\` with ${mcpServers.length} server(s)`);
      await this.log(ctx.agentTaskId, 'INFO', `MCP config generated`, { servers: mcpServers.map(s => s.name) });

    } catch (err) {
      result.steps.push(this.step('generateMcpConfig', 'failed', err.message, start));
      await this.sendAgentMessage(ctx, `⚠️ MCP config generation failed (non-fatal): ${err.message}`);
      await this.log(ctx.agentTaskId, 'WARN', `MCP config failed: ${err.message}`);
    }
  }

  // ─── Step 6b: Generate .gitlab-ci.yml ───────────────────────

  private async stepGenerateCiConfig(
    ctx: AgentContext,
    result: DevopsSetupResult,
    projectDir: string,
    interviewResult: InterviewResult,
  ): Promise<void> {
    const start = Date.now();
    try {
      const framework = (interviewResult.techStack?.framework ?? '').toLowerCase();
      const language = (interviewResult.techStack?.language ?? '').toLowerCase();

      const ciYml = this.buildCiYml(framework, language);

      const ciPath = path.join(projectDir, '.gitlab-ci.yml');
      await fs.writeFile(ciPath, ciYml, 'utf-8');

      result.steps.push(this.step('generateCiConfig', 'success', 'CI/CD config generated', start));
      await this.sendAgentMessage(ctx, `🔄 Generated \`.gitlab-ci.yml\` (${framework || 'generic'} template)`);
      await this.log(ctx.agentTaskId, 'INFO', 'CI config generated', { framework, language });

    } catch (err) {
      result.steps.push(this.step('generateCiConfig', 'failed', err.message, start));
      await this.sendAgentMessage(ctx, `⚠️ CI config generation failed (non-fatal): ${err.message}`);
      await this.log(ctx.agentTaskId, 'WARN', `CI config failed: ${err.message}`);
    }
  }

  /** Build a deterministic .gitlab-ci.yml based on the tech stack */
  private buildCiYml(framework: string, language: string): string {
    // Angular / React / Vue / Node projects
    if (['angular', 'react', 'vue', 'next', 'nuxt', 'svelte'].includes(framework) ||
        ['typescript', 'javascript'].includes(language)) {
      return `stages:
  - install
  - lint
  - test
  - build

variables:
  NODE_ENV: "test"

install:
  stage: install
  tags: [docker, vibcode]
  image: node:22-alpine
  script:
    - npm ci --prefer-offline
  cache:
    key: \${CI_COMMIT_REF_SLUG}
    paths:
      - node_modules/
  artifacts:
    paths:
      - node_modules/
    expire_in: 1 hour

lint:
  stage: lint
  tags: [docker, vibcode]
  image: node:22-alpine
  needs: [install]
  script:
    - npm run lint --if-present

test:
  stage: test
  tags: [docker, vibcode]
  image: node:22-alpine
  needs: [install]
  script:
    - npm test --if-present
  allow_failure: true

build:
  stage: build
  tags: [docker, vibcode]
  image: node:22-alpine
  needs: [install]
  script:
    - npm run build
  artifacts:
    paths:
      - dist/
    expire_in: 1 week
`;
    }

    // Python projects
    if (['python', 'django', 'flask', 'fastapi'].includes(framework) ||
        language === 'python') {
      return `stages:
  - install
  - lint
  - test
  - build

install:
  stage: install
  tags: [docker, vibcode]
  image: python:3.12-slim
  script:
    - pip install -r requirements.txt
  cache:
    key: \${CI_COMMIT_REF_SLUG}
    paths:
      - .venv/

lint:
  stage: lint
  tags: [docker, vibcode]
  image: python:3.12-slim
  needs: [install]
  script:
    - pip install ruff
    - ruff check .
  allow_failure: true

test:
  stage: test
  tags: [docker, vibcode]
  image: python:3.12-slim
  needs: [install]
  script:
    - pip install pytest
    - pytest --tb=short
  allow_failure: true

build:
  stage: build
  tags: [docker, vibcode]
  image: python:3.12-slim
  needs: [install]
  script:
    - echo "Build step — customize as needed"
`;
    }

    // Rust projects
    if (framework === 'rust' || language === 'rust') {
      return `stages:
  - lint
  - test
  - build

lint:
  stage: lint
  tags: [docker, vibcode]
  image: rust:latest
  script:
    - rustup component add clippy
    - cargo clippy -- -D warnings
  allow_failure: true

test:
  stage: test
  tags: [docker, vibcode]
  image: rust:latest
  script:
    - cargo test
  allow_failure: true

build:
  stage: build
  tags: [docker, vibcode]
  image: rust:latest
  script:
    - cargo build --release
  artifacts:
    paths:
      - target/release/
    expire_in: 1 week
`;
    }

    // Go projects
    if (framework === 'go' || language === 'go') {
      return `stages:
  - lint
  - test
  - build

lint:
  stage: lint
  tags: [docker, vibcode]
  image: golang:1.22
  script:
    - go vet ./...
  allow_failure: true

test:
  stage: test
  tags: [docker, vibcode]
  image: golang:1.22
  script:
    - go test ./...
  allow_failure: true

build:
  stage: build
  tags: [docker, vibcode]
  image: golang:1.22
  script:
    - go build -o app ./...
  artifacts:
    paths:
      - app
    expire_in: 1 week
`;
    }

    // Generic fallback
    return `stages:
  - build

build:
  stage: build
  tags: [docker, vibcode]
  script:
    - echo "Configure CI/CD pipeline for your project"
    - echo "Framework detection did not match a known template"
`;
  }

  // ─── Step 7: Git Commit & Push ─────────────────────────────

  private async stepGitCommitAndPush(
    ctx: AgentContext,
    result: DevopsSetupResult,
    projectDir: string,
    defaultBranch: string,
  ): Promise<void> {
    const start = Date.now();
    try {
      // Check if there are changes to commit
      const { stdout: statusOut } = await execFileAsync('git', ['status', '--porcelain'], {
        cwd: projectDir,
        timeout: 10_000,
      });

      if (!statusOut.trim()) {
        result.steps.push(this.step('gitCommitAndPush', 'skipped', 'No changes to commit', start));
        await this.sendAgentMessage(ctx, `📝 No changes to commit — repository is clean`);
        return;
      }

      await this.sendAgentMessage(ctx, `📤 Committing and pushing changes...`);

      // git add .
      await execFileAsync('git', ['add', '.'], {
        cwd: projectDir,
        timeout: 30_000,
      });

      // git commit
      await execFileAsync(
        'git',
        ['commit', '-m', 'chore: initial project setup by DevOps agent'],
        { cwd: projectDir, timeout: 30_000 },
      );

      // git push
      await execFileAsync('git', ['push', 'origin', defaultBranch], {
        cwd: projectDir,
        timeout: TIMEOUT_PUSH,
      });

      result.gitPushSuccess = true;
      result.steps.push(this.step('gitCommitAndPush', 'success', `Pushed to ${defaultBranch}`, start));
      await this.log(ctx.agentTaskId, 'INFO', `Git push to ${defaultBranch} successful`);

    } catch (err) {
      result.steps.push(this.step('gitCommitAndPush', 'failed', err.message, start));
      await this.sendAgentMessage(ctx, `⚠️ Git push failed (non-fatal): ${err.message}`);
      await this.log(ctx.agentTaskId, 'WARN', `Git push failed: ${err.message}`);
    }
  }

  // ─── Step 8: Finalize ──────────────────────────────────────

  private async stepFinalize(
    ctx: AgentContext,
    result: DevopsSetupResult,
  ): Promise<void> {
    const start = Date.now();
    try {
      // Update project status → READY
      await this.prisma.project.update({
        where: { id: ctx.projectId },
        data: { status: ProjectStatus.READY },
      });

      // Complete the task
      await this.prisma.agentTask.update({
        where: { id: ctx.agentTaskId },
        data: {
          status: AgentTaskStatus.COMPLETED,
          output: result as any,
          completedAt: new Date(),
        },
      });

      // Build summary
      const successCount = result.steps.filter(s => s.status === 'success').length;
      const failedCount = result.steps.filter(s => s.status === 'failed').length;
      const skippedCount = result.steps.filter(s => s.status === 'skipped').length;

      const summary = [
        `✅ **Project setup complete!**`,
        ``,
        `| Step | Status |`,
        `|------|--------|`,
        ...result.steps.map(s => `| ${s.name} | ${this.statusEmoji(s.status)} ${s.message} |`),
        ``,
        `**Summary:** ${successCount} passed, ${failedCount} failed, ${skippedCount} skipped`,
        `**Workspace:** \`${result.workspacePath}\``,
      ];

      await this.sendAgentMessage(ctx, summary.join('\n'));
      await this.updateStatus(ctx, AgentStatus.IDLE);
      await this.log(ctx.agentTaskId, 'INFO', 'DevOps setup completed', {
        successCount,
        failedCount,
        skippedCount,
      });

      // Broadcast project update for frontend
      this.chatGateway.emitToSession(ctx.chatSessionId, 'projectUpdated', {
        projectId: ctx.projectId,
        status: ProjectStatus.READY,
      });

      result.steps.push(this.step('finalize', 'success', 'Project status → READY', start));

      // Trigger Issue Compiler agent
      this.eventEmitter.emit('agent.devopsComplete', {
        projectId: ctx.projectId,
        chatSessionId: ctx.chatSessionId,
      });

    } catch (err) {
      result.steps.push(this.step('finalize', 'failed', err.message, start));
      await this.sendAgentMessage(ctx, `❌ Finalization failed: ${err.message}`);
      await this.log(ctx.agentTaskId, 'ERROR', `Finalize failed: ${err.message}`);
    }
  }

  // ─── Helpers ───────────────────────────────────────────────

  /** Parse a command string into [binary, ...args] respecting quotes */
  private parseCommand(command: string): string[] {
    const parts: string[] = [];
    let current = '';
    let inQuote: string | null = null;

    for (const char of command) {
      if (inQuote) {
        if (char === inQuote) {
          inQuote = null;
        } else {
          current += char;
        }
      } else if (char === '"' || char === "'") {
        inQuote = char;
      } else if (char === ' ') {
        if (current) {
          parts.push(current);
          current = '';
        }
      } else {
        current += char;
      }
    }
    if (current) parts.push(current);
    return parts;
  }

  /** Execute a command with allowlist enforcement */
  private async executeCommand(
    command: string,
    cwd: string,
    timeout: number,
  ): Promise<CommandResult> {
    const parts = this.parseCommand(command);
    if (parts.length === 0) {
      return { command, exitCode: 1, stdout: '', stderr: 'Empty command' };
    }

    const binary = parts[0];
    const args = parts.slice(1);

    // Allowlist check
    if (!ALLOWED_BINARIES.has(binary)) {
      return {
        command,
        exitCode: 1,
        stdout: '',
        stderr: `Binary "${binary}" is not in the allowlist. Allowed: ${[...ALLOWED_BINARIES].join(', ')}`,
      };
    }

    // Replace {PORT} placeholder if present
    const processedArgs = args.map(arg =>
      arg.replace(/\{PORT\}/g, '3000'),
    );

    try {
      const { stdout, stderr } = await execFileAsync(binary, processedArgs, {
        cwd,
        timeout,
        maxBuffer: 10 * 1024 * 1024, // 10 MB
        env: { ...process.env, CI: 'true' }, // Prevent interactive prompts
      });
      return { command, exitCode: 0, stdout, stderr };
    } catch (err: any) {
      return {
        command,
        exitCode: err.code ?? 1,
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? err.message,
      };
    }
  }

  /** Create a SetupStep record */
  private step(
    name: string,
    status: SetupStep['status'],
    message: string,
    startTime: number,
  ): SetupStep {
    return { name, status, message, durationMs: Date.now() - startTime };
  }

  /** Status emoji for summary table */
  private statusEmoji(status: SetupStep['status']): string {
    switch (status) {
      case 'success': return '✅';
      case 'failed': return '❌';
      case 'skipped': return '⏭️';
    }
  }

  /** Mark the task as failed and update agent status */
  private async markFailed(
    ctx: AgentContext,
    result: DevopsSetupResult,
    reason: string,
  ): Promise<void> {
    try {
      await this.prisma.agentTask.update({
        where: { id: ctx.agentTaskId },
        data: {
          status: AgentTaskStatus.FAILED,
          output: result as any,
          completedAt: new Date(),
        },
      });

      await this.prisma.project.update({
        where: { id: ctx.projectId },
        data: { status: ProjectStatus.SETTING_UP }, // Keep at SETTING_UP so user can retry
      });

      await this.updateStatus(ctx, AgentStatus.ERROR);
      await this.log(ctx.agentTaskId, 'ERROR', `Setup failed: ${reason}`);
    } catch (err) {
      this.logger.error(`Failed to mark task as failed: ${err.message}`);
    }
  }
}
