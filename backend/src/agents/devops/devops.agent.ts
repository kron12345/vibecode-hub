import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs/promises';
import { PrismaService } from '../../prisma/prisma.service';
import { SystemSettingsService } from '../../settings/system-settings.service';
import { ChatService } from '../../chat/chat.service';
import { ChatGateway } from '../../chat/chat.gateway';
import { LlmService } from '../../llm/llm.service';
import { GitlabService } from '../../gitlab/gitlab.service';
import {
  BaseAgent,
  AgentContext,
  KNOWLEDGE_BASE_FILE,
  ENVIRONMENT_FILE,
  sanitizeJsonOutput,
} from '../agent-base';
import { McpAgentLoopService } from '../../mcp/mcp-agent-loop.service';
import { McpRegistryService } from '../../mcp/mcp-registry.service';
import { MonitorGateway } from '../../monitor/monitor.gateway';
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

// Extracted helpers
import { MCP_SERVER_REGISTRY, buildCiYml, buildGitignore } from './devops-ci';
import {
  buildEnvironmentDoc,
  buildKnowledgeBaseDoc,
  buildReadme,
  buildChangelog,
  buildContributing,
  buildWikiHome,
  buildWikiSidebar,
  buildWikiArchOverview,
} from './devops-environment';
import { buildInfraSystemPrompt } from './devops-infra';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

// Timeout constants now configurable via PipelineConfig:
// - devopsCloneTimeoutMs (default: 120000)
// - devopsCommandTimeoutMs (default: 300000)
// - devopsPushTimeoutMs (default: 120000)

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
    monitorGateway: MonitorGateway,
    private readonly eventEmitter: EventEmitter2,
    private readonly mcpAgentLoop: McpAgentLoopService,
    private readonly mcpRegistry: McpRegistryService,
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
      await this.sendAgentMessage(
        ctx,
        '🔧 **DevOps Agent** starting project setup...',
      );

      // Step 1: Load project data
      const projectData = await this.stepLoadProject(ctx, result);
      if (!projectData) return; // Fatal — already handled

      const { project, interviewResult, gitlabProject } = projectData;

      // Step 2: Prepare workspace
      const projectDir = await this.stepPrepareWorkspace(
        ctx,
        result,
        project.slug,
      );
      if (!projectDir) return; // Fatal

      result.workspacePath = projectDir;

      // Step 3: Clone repository
      const cloneSuccess = await this.stepCloneRepository(
        ctx,
        result,
        projectDir,
        gitlabProject.path_with_namespace,
      );
      if (!cloneSuccess) return; // Fatal

      // Step 4: Run init command
      await this.stepRunInitCommand(ctx, result, projectDir, interviewResult);

      // Step 5: Run additional commands
      await this.stepRunAdditionalCommands(
        ctx,
        result,
        projectDir,
        interviewResult,
      );

      // Step 6: Generate .mcp.json
      await this.stepGenerateMcpConfig(
        ctx,
        result,
        projectDir,
        interviewResult,
      );

      // Step 6b: Generate .gitlab-ci.yml
      await this.stepGenerateCiConfig(ctx, result, projectDir, interviewResult);

      // Step 6c: Generate .gitignore
      await this.stepGenerateGitignore(
        ctx,
        result,
        projectDir,
        interviewResult,
      );

      // Step 6d: Generate project documentation (README, CHANGELOG, CONTRIBUTING, Knowledge Base)
      await this.stepGenerateProjectDocs(
        ctx,
        result,
        projectDir,
        project.name,
        interviewResult,
        project.gitlabProjectId!,
      );

      // Step 6e: Generate ENVIRONMENT.md
      await this.stepGenerateEnvironmentDoc(
        ctx,
        result,
        projectDir,
        project.name,
        interviewResult,
        project.gitlabProjectId!,
      );

      // Step 6f: Build verification for Maven/Java projects
      await this.stepBuildVerification(
        ctx,
        result,
        projectDir,
        interviewResult,
      );

      // Step 7: Git commit & push
      await this.stepGitCommitAndPush(
        ctx,
        result,
        projectDir,
        gitlabProject.default_branch,
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

  private async stepLoadProject(ctx: AgentContext, result: DevopsSetupResult) {
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
        this.logger.log(
          `GitLab repo created by DevOps agent: ${glProject.web_url}`,
        );

        // Auto-add owner as Maintainer
        const ownerUserId = this.settings.gitlabOwnerUserId;
        if (ownerUserId) {
          try {
            await this.gitlabService.addProjectMember(
              glProject.id,
              ownerUserId,
              40,
            );
          } catch (err) {
            this.logger.warn(
              `Could not auto-add owner to GitLab project: ${err.message}`,
            );
          }
        }
      }

      const gitlabProject = await this.gitlabService.getProject(
        project.gitlabProjectId!,
      );

      result.steps.push(
        this.step('loadProjectData', 'success', 'Project data loaded', start),
      );
      return { project, interviewResult, gitlabProject };
    } catch (err) {
      result.steps.push(
        this.step('loadProjectData', 'failed', err.message, start),
      );
      await this.sendAgentMessage(
        ctx,
        `❌ Failed to load project data: ${err.message}`,
      );
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
      if (
        projectDir !== basePath &&
        !projectDir.startsWith(basePath + path.sep)
      ) {
        throw new Error('Path traversal detected — slug produces invalid path');
      }

      await execFileAsync('mkdir', ['-p', projectDir], { timeout: 10_000 });
      await this.log(ctx.agentTaskId, 'INFO', `Workspace: ${projectDir}`);

      result.steps.push(
        this.step(
          'prepareWorkspace',
          'success',
          `Directory: ${projectDir}`,
          start,
        ),
      );
      return projectDir;
    } catch (err) {
      result.steps.push(
        this.step('prepareWorkspace', 'failed', err.message, start),
      );
      await this.sendAgentMessage(
        ctx,
        `❌ Failed to prepare workspace: ${err.message}`,
      );
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
        await this.sendAgentMessage(
          ctx,
          `📂 Stale workspace found — re-cloning fresh...`,
        );
        await execFileAsync('rm', ['-rf', projectDir], { timeout: 30_000 });
        await execFileAsync('mkdir', ['-p', projectDir], { timeout: 10_000 });
        await execFileAsync('git', ['clone', cloneUrl, '.'], {
          cwd: projectDir,
          timeout: this.getDevopsCloneTimeoutMs(),
        });
        await this.log(
          ctx.agentTaskId,
          'INFO',
          `Re-cloned fresh: ${redactedUrl}`,
        );
      } else {
        await this.sendAgentMessage(
          ctx,
          `📥 Cloning repository from GitLab...`,
        );
        // Clone into the project directory (which was just created and is empty)
        await execFileAsync('git', ['clone', cloneUrl, '.'], {
          cwd: projectDir,
          timeout: this.getDevopsCloneTimeoutMs(),
        });
        await this.log(
          ctx.agentTaskId,
          'INFO',
          `Git clone completed: ${redactedUrl}`,
        );
      }

      // Fence: ensure package.json exists in workspace root to prevent npm
      // from walking up the directory tree into the Hub's package.json
      await this.ensureWorkspaceFence(projectDir);

      result.cloneSuccess = true;
      result.steps.push(
        this.step(
          'cloneRepository',
          'success',
          alreadyCloned ? 'Pulled latest changes' : 'Cloned successfully',
          start,
        ),
      );
      return true;
    } catch (err) {
      result.cloneSuccess = false;
      result.steps.push(
        this.step('cloneRepository', 'failed', err.message, start),
      );
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
      result.steps.push(
        this.step(
          'runInitCommand',
          'skipped',
          'No init command specified',
          start,
        ),
      );
      return;
    }

    try {
      await this.sendAgentMessage(
        ctx,
        `⚙️ Running init command: \`${initCommand}\``,
      );
      const cmdResult = await this.executeCommand(
        initCommand,
        projectDir,
        this.getDevopsCommandTimeoutMs(),
      );
      result.initCommandResult = cmdResult;

      if (cmdResult.exitCode !== 0) {
        throw new Error(
          `Exit code ${cmdResult.exitCode}: ${cmdResult.stderr.slice(0, 500)}`,
        );
      }

      result.steps.push(
        this.step('runInitCommand', 'success', 'Init command completed', start),
      );
      await this.log(
        ctx.agentTaskId,
        'INFO',
        `Init command OK: ${initCommand}`,
      );
    } catch (err) {
      result.steps.push(
        this.step('runInitCommand', 'failed', err.message, start),
      );
      await this.sendAgentMessage(
        ctx,
        `⚠️ Init command failed (non-fatal): ${err.message}`,
      );
      await this.log(
        ctx.agentTaskId,
        'WARN',
        `Init command failed: ${err.message}`,
      );
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
      result.steps.push(
        this.step(
          'runAdditionalCommands',
          'skipped',
          'No additional commands',
          start,
        ),
      );
      return;
    }

    let allOk = true;
    for (const cmd of commands) {
      try {
        await this.sendAgentMessage(ctx, `⚙️ Running: \`${cmd}\``);
        const cmdResult = await this.executeCommand(
          cmd,
          projectDir,
          this.getDevopsCommandTimeoutMs(),
        );
        result.additionalCommandResults.push(cmdResult);

        if (cmdResult.exitCode !== 0) {
          throw new Error(
            `Exit code ${cmdResult.exitCode}: ${cmdResult.stderr.slice(0, 500)}`,
          );
        }

        await this.log(
          ctx.agentTaskId,
          'INFO',
          `Additional command OK: ${cmd}`,
        );
      } catch (err) {
        allOk = false;
        await this.sendAgentMessage(
          ctx,
          `⚠️ Command failed (non-fatal): \`${cmd}\` — ${err.message}`,
        );
        await this.log(
          ctx.agentTaskId,
          'WARN',
          `Additional command failed: ${cmd}`,
          { error: err.message },
        );
      }
    }

    result.steps.push(
      this.step(
        'runAdditionalCommands',
        allOk ? 'success' : 'failed',
        allOk
          ? `${commands.length} commands completed`
          : 'Some commands failed',
        start,
      ),
    );
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
      result.steps.push(
        this.step(
          'generateMcpConfig',
          'skipped',
          'No MCP servers defined',
          start,
        ),
      );
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
          await this.log(
            ctx.agentTaskId,
            'INFO',
            `Unknown MCP server "${server.name}" — using npx fallback`,
          );
        }
      }

      const mcpJson = JSON.stringify({ mcpServers: mcpConfig }, null, 2);
      const mcpPath = path.join(projectDir, '.mcp.json');
      await fs.writeFile(mcpPath, mcpJson + '\n', 'utf-8');

      result.mcpConfigGenerated = true;
      result.steps.push(
        this.step(
          'generateMcpConfig',
          'success',
          `${mcpServers.length} MCP servers configured`,
          start,
        ),
      );
      await this.sendAgentMessage(
        ctx,
        `📋 Generated \`.mcp.json\` with ${mcpServers.length} server(s)`,
      );
      await this.log(ctx.agentTaskId, 'INFO', `MCP config generated`, {
        servers: mcpServers.map((s) => s.name),
      });
    } catch (err) {
      result.steps.push(
        this.step('generateMcpConfig', 'failed', err.message, start),
      );
      await this.sendAgentMessage(
        ctx,
        `⚠️ MCP config generation failed (non-fatal): ${err.message}`,
      );
      await this.log(
        ctx.agentTaskId,
        'WARN',
        `MCP config failed: ${err.message}`,
      );
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
      const framework = (
        interviewResult.techStack?.framework ?? ''
      ).toLowerCase();
      const language = (
        interviewResult.techStack?.language ?? ''
      ).toLowerCase();

      const ciYml = buildCiYml(framework, language);

      const ciPath = path.join(projectDir, '.gitlab-ci.yml');
      await fs.writeFile(ciPath, ciYml, 'utf-8');

      result.steps.push(
        this.step(
          'generateCiConfig',
          'success',
          'CI/CD config generated',
          start,
        ),
      );
      await this.sendAgentMessage(
        ctx,
        `🔄 Generated \`.gitlab-ci.yml\` (${framework || 'generic'} template)`,
      );
      await this.log(ctx.agentTaskId, 'INFO', 'CI config generated', {
        framework,
        language,
      });
    } catch (err) {
      result.steps.push(
        this.step('generateCiConfig', 'failed', err.message, start),
      );
      await this.sendAgentMessage(
        ctx,
        `⚠️ CI config generation failed (non-fatal): ${err.message}`,
      );
      await this.log(
        ctx.agentTaskId,
        'WARN',
        `CI config failed: ${err.message}`,
      );
    }
  }

  // ─── Step 6c: Generate .gitignore ──────────────────────────

  private async stepGenerateGitignore(
    ctx: AgentContext,
    result: DevopsSetupResult,
    projectDir: string,
    interviewResult: InterviewResult,
  ): Promise<void> {
    const start = Date.now();
    try {
      const framework = (
        interviewResult.techStack?.framework ?? ''
      ).toLowerCase();
      const language = (
        interviewResult.techStack?.language ?? ''
      ).toLowerCase();

      const gitignoreContent = buildGitignore(framework, language);
      const gitignorePath = path.join(projectDir, '.gitignore');
      await fs.writeFile(gitignorePath, gitignoreContent, 'utf-8');

      result.steps.push(
        this.step(
          'generateGitignore',
          'success',
          '.gitignore generated',
          start,
        ),
      );
      await this.sendAgentMessage(
        ctx,
        `📋 Generated \`.gitignore\` for ${framework || language || 'generic'} project`,
      );
    } catch (err) {
      result.steps.push(
        this.step('generateGitignore', 'failed', err.message, start),
      );
      await this.log(
        ctx.agentTaskId,
        'WARN',
        `.gitignore generation failed: ${err.message}`,
      );
    }
  }

  // ─── Step 6d: Generate Project Documentation ───────────────

  private async stepGenerateProjectDocs(
    ctx: AgentContext,
    result: DevopsSetupResult,
    projectDir: string,
    projectName: string,
    interviewResult: InterviewResult,
    gitlabProjectId: number,
  ): Promise<void> {
    const start = Date.now();
    try {
      // Write PROJECT_KNOWLEDGE.md
      const knowledgeBase = buildKnowledgeBaseDoc(projectName, interviewResult);
      await fs.writeFile(
        path.join(projectDir, KNOWLEDGE_BASE_FILE),
        knowledgeBase,
        'utf-8',
      );

      // Write README.md (only if it doesn't exist yet)
      const readmePath = path.join(projectDir, 'README.md');
      try {
        await fs.access(readmePath);
        this.logger.log('README.md already exists — skipping');
      } catch {
        const readme = buildReadme(projectName, interviewResult);
        await fs.writeFile(readmePath, readme, 'utf-8');
      }

      // Write CHANGELOG.md
      await fs.writeFile(
        path.join(projectDir, 'CHANGELOG.md'),
        buildChangelog(),
        'utf-8',
      );

      // Write CONTRIBUTING.md
      await fs.writeFile(
        path.join(projectDir, 'CONTRIBUTING.md'),
        buildContributing(projectName, interviewResult),
        'utf-8',
      );

      // Wiki Scaffolding
      try {
        await this.gitlabService.upsertWikiPage(
          gitlabProjectId,
          'home',
          buildWikiHome(projectName, interviewResult),
        );
        await this.gitlabService.upsertWikiPage(
          gitlabProjectId,
          '_sidebar',
          buildWikiSidebar(projectName),
        );
        await this.gitlabService.upsertWikiPage(
          gitlabProjectId,
          'PROJECT_KNOWLEDGE',
          knowledgeBase,
        );
        await this.gitlabService.upsertWikiPage(
          gitlabProjectId,
          'Architecture/Overview',
          buildWikiArchOverview(projectName, interviewResult),
        );
        this.logger.log(
          `Wiki scaffolding created for project ${gitlabProjectId}`,
        );
      } catch (err) {
        this.logger.warn(`Wiki scaffolding failed (non-fatal): ${err.message}`);
      }

      result.steps.push(
        this.step(
          'generateProjectDocs',
          'success',
          'README, CHANGELOG, CONTRIBUTING, Knowledge Base + Wiki generated',
          start,
        ),
      );
      await this.sendAgentMessage(
        ctx,
        `📚 Generated project documentation (README.md, CHANGELOG.md, CONTRIBUTING.md, ${KNOWLEDGE_BASE_FILE}) + Wiki scaffolding`,
      );
    } catch (err) {
      result.steps.push(
        this.step('generateProjectDocs', 'failed', err.message, start),
      );
      await this.log(
        ctx.agentTaskId,
        'WARN',
        `Project docs generation failed: ${err.message}`,
      );
    }
  }

  // ─── Step 6e: Generate ENVIRONMENT.md ────────────────────

  private async stepGenerateEnvironmentDoc(
    ctx: AgentContext,
    result: DevopsSetupResult,
    projectDir: string,
    projectName: string,
    interviewResult: InterviewResult,
    gitlabProjectId: number,
  ): Promise<void> {
    const start = Date.now();
    try {
      const envContent = buildEnvironmentDoc(projectName, interviewResult);
      await fs.writeFile(
        path.join(projectDir, ENVIRONMENT_FILE),
        envContent,
        'utf-8',
      );

      // Sync ENVIRONMENT to wiki
      try {
        await this.gitlabService.upsertWikiPage(
          gitlabProjectId,
          'ENVIRONMENT',
          envContent,
        );
        this.logger.log('ENVIRONMENT wiki page synced');
      } catch (err) {
        this.logger.warn(
          `ENVIRONMENT wiki sync failed (non-fatal): ${err.message}`,
        );
      }

      result.steps.push(
        this.step(
          'generateEnvironmentDoc',
          'success',
          'ENVIRONMENT.md generated + wiki synced',
          start,
        ),
      );
      await this.sendAgentMessage(
        ctx,
        `📋 Generated \`ENVIRONMENT.md\` — project environment documentation + wiki synced`,
      );
    } catch (err) {
      result.steps.push(
        this.step('generateEnvironmentDoc', 'failed', err.message, start),
      );
      await this.log(
        ctx.agentTaskId,
        'WARN',
        `ENVIRONMENT.md generation failed: ${err.message}`,
      );
    }
  }

  // ─── Step 6f: Build Verification (Maven/Gradle) ───────────

  /**
   * For Java/Maven projects: resolve dependencies and compile to verify the build works.
   * This pre-caches all Maven dependencies so agents can compile/test without network issues.
   */
  private async stepBuildVerification(
    ctx: AgentContext,
    result: DevopsSetupResult,
    projectDir: string,
    interviewResult: InterviewResult,
  ): Promise<void> {
    const start = Date.now();
    const framework = (interviewResult.techStack?.framework ?? '')
      .toLowerCase()
      .replace(/\s+/g, '-');
    const language = (interviewResult.techStack?.language ?? '').toLowerCase();

    const isMaven =
      ['spring', 'spring-boot', 'vaadin', 'quarkus'].some((f) =>
        framework.includes(f),
      ) || language.includes('java');

    if (!isMaven) {
      result.steps.push(
        this.step('buildVerification', 'skipped', 'Not a Maven project', start),
      );
      return;
    }

    // Check if pom.xml exists
    const fsSync = await import('fs');
    const pomPath = path.join(projectDir, 'pom.xml');
    if (!fsSync.existsSync(pomPath)) {
      result.steps.push(
        this.step('buildVerification', 'skipped', 'No pom.xml found', start),
      );
      return;
    }

    try {
      await this.sendAgentMessage(
        ctx,
        '📦 Maven: Resolving dependencies and verifying build...',
      );

      // Step 1: Resolve all dependencies (pre-cache in ~/.m2/repository)
      const resolveResult = await this.executeCommand(
        'mvn dependency:resolve -B -q',
        projectDir,
        this.getDevopsCommandTimeoutMs(),
      );

      if (resolveResult.exitCode !== 0) {
        this.logger.warn(
          `Maven dependency:resolve failed: ${resolveResult.stderr.slice(0, 300)}`,
        );
        await this.sendAgentMessage(
          ctx,
          `⚠️ Maven dependency resolution failed (non-fatal): ${resolveResult.stderr.slice(0, 200)}`,
        );
        result.steps.push(
          this.step(
            'buildVerification',
            'failed',
            'Dependency resolution failed',
            start,
          ),
        );
        return;
      }

      // Step 2: Compile to verify code compiles
      const compileResult = await this.executeCommand(
        'mvn compile -B -q',
        projectDir,
        this.getDevopsCommandTimeoutMs(),
      );

      if (compileResult.exitCode !== 0) {
        this.logger.warn(
          `Maven compile failed: ${compileResult.stderr.slice(0, 300)}`,
        );
        await this.sendAgentMessage(
          ctx,
          `⚠️ Maven compile failed (non-fatal): ${compileResult.stderr.slice(0, 200)}`,
        );
        result.steps.push(
          this.step('buildVerification', 'failed', 'Compilation failed', start),
        );
        return;
      }

      await this.sendAgentMessage(
        ctx,
        '✅ Maven build verified — dependencies cached, compilation OK',
      );
      result.steps.push(
        this.step(
          'buildVerification',
          'success',
          'Maven deps resolved + compile OK',
          start,
        ),
      );
      await this.log(
        ctx.agentTaskId,
        'INFO',
        'Maven build verification passed',
      );
    } catch (err) {
      result.steps.push(
        this.step('buildVerification', 'failed', err.message, start),
      );
      await this.sendAgentMessage(
        ctx,
        `⚠️ Build verification failed (non-fatal): ${err.message}`,
      );
      await this.log(
        ctx.agentTaskId,
        'WARN',
        `Build verification failed: ${err.message}`,
      );
    }
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
      const { stdout: statusOut } = await execFileAsync(
        'git',
        ['status', '--porcelain'],
        {
          cwd: projectDir,
          timeout: 10_000,
        },
      );

      if (!statusOut.trim()) {
        result.steps.push(
          this.step(
            'gitCommitAndPush',
            'skipped',
            'No changes to commit',
            start,
          ),
        );
        await this.sendAgentMessage(
          ctx,
          `📝 No changes to commit — repository is clean`,
        );
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
        timeout: this.getDevopsPushTimeoutMs(),
      });

      result.gitPushSuccess = true;
      result.steps.push(
        this.step(
          'gitCommitAndPush',
          'success',
          `Pushed to ${defaultBranch}`,
          start,
        ),
      );
      await this.log(
        ctx.agentTaskId,
        'INFO',
        `Git push to ${defaultBranch} successful`,
      );
    } catch (err) {
      result.steps.push(
        this.step('gitCommitAndPush', 'failed', err.message, start),
      );
      await this.sendAgentMessage(
        ctx,
        `⚠️ Git push failed (non-fatal): ${err.message}`,
      );
      await this.log(
        ctx.agentTaskId,
        'WARN',
        `Git push failed: ${err.message}`,
      );
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
          output: sanitizeJsonOutput(result) as any,
          completedAt: new Date(),
        },
      });

      // Build summary
      const successCount = result.steps.filter(
        (s) => s.status === 'success',
      ).length;
      const failedCount = result.steps.filter(
        (s) => s.status === 'failed',
      ).length;
      const skippedCount = result.steps.filter(
        (s) => s.status === 'skipped',
      ).length;

      const summary = [
        `✅ **Project setup complete!**`,
        ``,
        `| Step | Status |`,
        `|------|--------|`,
        ...result.steps.map(
          (s) => `| ${s.name} | ${this.statusEmoji(s.status)} ${s.message} |`,
        ),
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

      result.steps.push(
        this.step('finalize', 'success', 'Project status → READY', start),
      );

      // Trigger Issue Compiler agent
      this.eventEmitter.emit('agent.devopsComplete', {
        projectId: ctx.projectId,
        chatSessionId: ctx.chatSessionId,
      });
    } catch (err) {
      result.steps.push(this.step('finalize', 'failed', err.message, start));
      await this.sendAgentMessage(
        ctx,
        `❌ Finalization failed: ${err.message}`,
      );
      await this.log(
        ctx.agentTaskId,
        'ERROR',
        `Finalize failed: ${err.message}`,
      );
    }
  }

  // ─── YOLO Mode: Infrastructure Commands ──────────────────

  /**
   * Handle an infrastructure command from the YOLO mode chat.
   * Uses MCP agent loop with filesystem, git, and shell tools
   * to execute user-requested infra changes, then updates ENVIRONMENT.md.
   */
  async handleInfraCommand(
    ctx: AgentContext,
    userMessage: string,
  ): Promise<void> {
    try {
      await this.updateStatus(ctx, AgentStatus.WORKING);
      await this.log(ctx.agentTaskId, 'INFO', 'Infra command started', {
        userMessage: userMessage.substring(0, 200),
      });

      // Load project
      const project = await this.prisma.project.findUnique({
        where: { id: ctx.projectId },
      });
      if (!project) {
        await this.sendAgentMessage(ctx, '❌ Project not found.');
        await this.updateStatus(ctx, AgentStatus.ERROR);
        return;
      }

      const workspace = path.resolve(
        this.settings.devopsWorkspacePath,
        project.slug,
      );

      // Resolve MCP servers for DEVOPS role
      const mcpServers = await this.mcpRegistry.resolveServersForRole(
        AgentRole.DEVOPS,
        { workspace, allowedPaths: [workspace], projectId: ctx.projectId },
      );

      // Read current environment doc + knowledge from wiki (fallback to file)
      const envDoc = await this.readEnvironment(
        this.gitlabService,
        project.gitlabProjectId,
        workspace,
      );
      const knowledgeSection = await this.buildKnowledgeSectionWiki(
        this.gitlabService,
        project.gitlabProjectId,
        workspace,
      );

      const systemPrompt = buildInfraSystemPrompt(
        workspace,
        envDoc,
        knowledgeSection,
      );

      const result = await this.mcpAgentLoop.run({
        provider: this.getRoleConfig().provider,
        model: this.getRoleConfig().model,
        systemPrompt,
        userPrompt: userMessage,
        mcpServers,
        maxIterations: 20,
        temperature: this.getRoleConfig().parameters.temperature,
        maxTokens: this.getRoleConfig().parameters.maxTokens,
        agentTaskId: ctx.agentTaskId,
        cwd: workspace,
        onToolCall: (name, args) => {
          this.logger.debug(
            `Infra tool: ${name}(${JSON.stringify(args).substring(0, 150)})`,
          );
        },
        onIteration: (iteration) => {
          this.logger.debug(`Infra agent loop iteration ${iteration}`);
        },
      });

      this.logger.log(
        `Infra command done: ${result.finishReason}, ${result.iterations} iters, ${result.toolCallsExecuted} tool calls`,
      );

      // Send the agent's summary to chat
      if (result.content) {
        await this.sendAgentMessage(ctx, result.content);
      }

      // Sync updated ENVIRONMENT.md back to wiki
      if (project.gitlabProjectId) {
        try {
          const updatedEnv = await this.readEnvironmentDoc(workspace);
          if (updatedEnv) {
            await this.gitlabService.upsertWikiPage(
              project.gitlabProjectId,
              'ENVIRONMENT',
              updatedEnv,
            );
            this.logger.log('ENVIRONMENT wiki page synced after infra command');
          }
        } catch (err) {
          this.logger.warn(
            `ENVIRONMENT wiki sync after infra failed: ${err.message}`,
          );
        }
      }

      // Mark task complete
      await this.prisma.agentTask.update({
        where: { id: ctx.agentTaskId },
        data: {
          status: AgentTaskStatus.COMPLETED,
          completedAt: new Date(),
          output: {
            finishReason: result.finishReason,
            iterations: result.iterations,
            toolCalls: result.toolCallsExecuted,
          } as any,
        },
      });

      await this.updateStatus(ctx, AgentStatus.IDLE);
      await this.log(ctx.agentTaskId, 'INFO', 'Infra command completed', {
        finishReason: result.finishReason,
        iterations: result.iterations,
      });
    } catch (err) {
      this.logger.error(`Infra command failed: ${err.message}`, err.stack);
      await this.sendAgentMessage(
        ctx,
        `❌ Infrastructure command failed: ${err.message}`,
      );

      await this.prisma.agentTask.update({
        where: { id: ctx.agentTaskId },
        data: {
          status: AgentTaskStatus.FAILED,
          completedAt: new Date(),
        },
      });

      await this.updateStatus(ctx, AgentStatus.IDLE);
      await this.log(
        ctx.agentTaskId,
        'ERROR',
        `Infra command failed: ${err.message}`,
      );
    }
  }

  // ─── Helpers ───────────────────────────────────────────────

  /**
   * Execute a command via shell.
   * Supports cd, &&, pipes, redirects — full shell syntax.
   * Commands run in the project workspace directory.
   */
  private async executeCommand(
    command: string,
    cwd: string,
    timeout: number,
  ): Promise<CommandResult> {
    if (!command.trim()) {
      return { command, exitCode: 1, stdout: '', stderr: 'Empty command' };
    }

    // Replace {PORT} placeholder if present
    const processedCommand = command.replace(/\{PORT\}/g, '3000');

    try {
      const { stdout, stderr } = await execAsync(processedCommand, {
        cwd,
        timeout,
        maxBuffer: 10 * 1024 * 1024, // 10 MB
        env: { ...process.env, CI: 'true', DEBIAN_FRONTEND: 'noninteractive' },
        shell: '/bin/bash',
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
      case 'success':
        return '✅';
      case 'failed':
        return '❌';
      case 'skipped':
        return '⏭️';
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
          output: sanitizeJsonOutput(result) as any,
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
