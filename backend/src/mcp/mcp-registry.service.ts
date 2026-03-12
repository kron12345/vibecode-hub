import { Injectable, Logger, OnModuleInit, NotFoundException, BadRequestException } from '@nestjs/common';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../settings/system-settings.service';
import { AgentRole, McpServerDefinition, McpOverrideAction } from '@prisma/client';
import { McpServerConfig } from './mcp.interfaces';
import { CreateMcpServerDto, UpdateMcpServerDto } from './mcp-registry.dto';

/** Runtime context passed when resolving MCP servers for an agent */
export interface McpRuntimeContext {
  workspace: string;
  allowedPaths?: string[];
  projectId?: string;
}

/** Shell server .mjs path (relative to compiled dist output) */
const SHELL_SERVER_PATH = path.resolve(__dirname, '..', '..', 'mcp', 'servers', 'shell-server.mjs');

@Injectable()
export class McpRegistryService implements OnModuleInit {
  private readonly logger = new Logger(McpRegistryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SystemSettingsService,
  ) {}

  async onModuleInit() {
    await this.seedBuiltinServers();
  }

  // ─── CRUD ────────────────────────────────────────────────────

  async findAll(): Promise<(McpServerDefinition & { roles: AgentRole[] })[]> {
    const servers = await this.prisma.mcpServerDefinition.findMany({
      include: { roles: true },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
    });
    return servers.map((s) => ({
      ...s,
      roles: s.roles.map((r) => r.agentRole),
    }));
  }

  async findOne(id: string) {
    const server = await this.prisma.mcpServerDefinition.findUnique({
      where: { id },
      include: { roles: true },
    });
    if (!server) throw new NotFoundException(`MCP server "${id}" not found`);
    return {
      ...server,
      roles: server.roles.map((r) => r.agentRole),
    };
  }

  async create(dto: CreateMcpServerDto) {
    const server = await this.prisma.mcpServerDefinition.create({
      data: {
        name: dto.name,
        displayName: dto.displayName,
        description: dto.description,
        category: dto.category || 'custom',
        command: dto.command,
        args: dto.args,
        env: dto.env ?? undefined,
        argTemplate: dto.argTemplate,
        enabled: dto.enabled ?? true,
        builtin: false,
      },
      include: { roles: true },
    });
    this.logger.log(`Created MCP server: ${server.name}`);
    return { ...server, roles: server.roles.map((r) => r.agentRole) };
  }

  async update(id: string, dto: UpdateMcpServerDto) {
    const existing = await this.prisma.mcpServerDefinition.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`MCP server "${id}" not found`);

    const server = await this.prisma.mcpServerDefinition.update({
      where: { id },
      data: {
        displayName: dto.displayName,
        description: dto.description,
        category: dto.category,
        command: dto.command,
        args: dto.args,
        env: dto.env ?? undefined,
        argTemplate: dto.argTemplate,
        enabled: dto.enabled,
      },
      include: { roles: true },
    });
    this.logger.log(`Updated MCP server: ${server.name}`);
    return { ...server, roles: server.roles.map((r) => r.agentRole) };
  }

  async delete(id: string) {
    const existing = await this.prisma.mcpServerDefinition.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`MCP server "${id}" not found`);
    if (existing.builtin) {
      throw new BadRequestException('Built-in servers cannot be deleted');
    }
    await this.prisma.mcpServerDefinition.delete({ where: { id } });
    this.logger.log(`Deleted MCP server: ${existing.name}`);
  }

  // ─── Role Assignments ────────────────────────────────────────

  async setRoleAssignments(serverId: string, roles: AgentRole[]) {
    const existing = await this.prisma.mcpServerDefinition.findUnique({ where: { id: serverId } });
    if (!existing) throw new NotFoundException(`MCP server "${serverId}" not found`);

    await this.prisma.$transaction([
      this.prisma.mcpServerOnRole.deleteMany({ where: { mcpServerId: serverId } }),
      ...roles.map((role) =>
        this.prisma.mcpServerOnRole.create({
          data: { mcpServerId: serverId, agentRole: role },
        }),
      ),
    ]);
    this.logger.log(`Set ${roles.length} role assignments for server "${existing.name}"`);
  }

  async getServersForRole(role: AgentRole): Promise<McpServerDefinition[]> {
    const assignments = await this.prisma.mcpServerOnRole.findMany({
      where: { agentRole: role },
      include: { mcpServer: true },
    });
    return assignments
      .map((a) => a.mcpServer)
      .filter((s) => s.enabled);
  }

  // ─── Project Overrides ───────────────────────────────────────

  async getProjectOverrides(projectId: string) {
    return this.prisma.mcpServerProjectOverride.findMany({
      where: { projectId },
      include: { mcpServer: { select: { id: true, name: true, displayName: true } } },
    });
  }

  async setProjectOverride(
    projectId: string,
    mcpServerId: string,
    agentRole: AgentRole,
    action: McpOverrideAction,
  ) {
    return this.prisma.mcpServerProjectOverride.upsert({
      where: {
        projectId_mcpServerId_agentRole: { projectId, mcpServerId, agentRole },
      },
      create: { projectId, mcpServerId, agentRole, action },
      update: { action },
    });
  }

  async deleteProjectOverride(
    projectId: string,
    mcpServerId: string,
    agentRole: AgentRole,
  ) {
    await this.prisma.mcpServerProjectOverride.deleteMany({
      where: { projectId, mcpServerId, agentRole },
    });
  }

  // ─── Resolution (DB → McpServerConfig[]) ────────────────────

  /**
   * Resolve MCP server definitions for a given agent role into
   * ready-to-use McpServerConfig objects with runtime args filled in.
   * Applies project-level overrides when projectId is provided.
   */
  async resolveServersForRole(
    role: AgentRole,
    context: McpRuntimeContext,
  ): Promise<McpServerConfig[]> {
    let servers = await this.getServersForRole(role);

    // Apply project-level overrides if projectId given
    if (context.projectId) {
      const overrides = await this.prisma.mcpServerProjectOverride.findMany({
        where: { projectId: context.projectId, agentRole: role },
      });

      if (overrides.length > 0) {
        const disabledIds = new Set(
          overrides.filter((o) => o.action === McpOverrideAction.DISABLE).map((o) => o.mcpServerId),
        );
        const enabledIds = new Set(
          overrides.filter((o) => o.action === McpOverrideAction.ENABLE).map((o) => o.mcpServerId),
        );

        // Remove disabled servers
        servers = servers.filter((s) => !disabledIds.has(s.id));

        // Add explicitly enabled servers that aren't already in the list
        if (enabledIds.size > 0) {
          const existingIds = new Set(servers.map((s) => s.id));
          const additionalServers = await this.prisma.mcpServerDefinition.findMany({
            where: { id: { in: [...enabledIds] }, enabled: true },
          });
          for (const s of additionalServers) {
            if (!existingIds.has(s.id)) servers.push(s);
          }
        }
      }
    }

    if (servers.length === 0) {
      this.logger.warn(`No MCP servers configured for role ${role} — using fallback`);
      return this.getFallbackServers(role, context);
    }

    return servers.map((s) => this.resolveServer(s, context));
  }

  /** Convert a single DB record into McpServerConfig with runtime placeholders replaced */
  private resolveServer(server: McpServerDefinition, context: McpRuntimeContext): McpServerConfig {
    const resolvedArgs = [...server.args];

    // Process argTemplate: replace placeholders and append to args
    if (server.argTemplate) {
      const templateParts = server.argTemplate.split(/\s+/).filter(Boolean);
      for (const part of templateParts) {
        if (part === '{workspace}') {
          resolvedArgs.push(context.workspace);
        } else if (part === '{allowedPaths}') {
          resolvedArgs.push(...(context.allowedPaths || [context.workspace]));
        } else if (part === '{shellServerPath}') {
          resolvedArgs.push(SHELL_SERVER_PATH);
        } else if (part === '{postgresConnectionString}') {
          const connStr = this.buildPostgresConnectionString();
          if (connStr) resolvedArgs.push(connStr);
        } else {
          resolvedArgs.push(part);
        }
      }
    }

    // Process envTemplate: resolve {settings:key} placeholders from SystemSettingsService
    let resolvedEnv: Record<string, string> | undefined;
    const staticEnv = (server.env as Record<string, string>) || {};
    const envTemplate = (server.envTemplate as Record<string, string>) || {};

    const mergedEnv: Record<string, string> = { ...staticEnv };
    for (const [key, template] of Object.entries(envTemplate)) {
      const match = template.match(/^\{settings:(.+)\}$/);
      if (match) {
        const settingValue = this.settings.get(match[1]);
        if (settingValue) {
          mergedEnv[key] = settingValue;
        }
      } else {
        // Literal value in envTemplate
        mergedEnv[key] = template;
      }
    }
    if (Object.keys(mergedEnv).length > 0) {
      resolvedEnv = mergedEnv;
    }

    const config: McpServerConfig = {
      name: server.name,
      command: server.command,
      args: resolvedArgs,
      env: resolvedEnv,
    };

    // Convention: empty command + argTemplate starting with "http" = remote HTTP MCP server
    if (!server.command && server.argTemplate?.startsWith('http')) {
      config.transport = 'http';
      config.url = server.argTemplate;
    }

    return config;
  }

  /** Build a PostgreSQL connection string from settings/env for project DBs */
  private buildPostgresConnectionString(): string | null {
    const url = this.settings.get('database.url', 'DATABASE_URL', '');
    if (url) return url;
    // Fallback: build from individual parts
    const host = this.settings.get('database.host', 'DB_HOST', 'localhost');
    const port = this.settings.get('database.port', 'DB_PORT', '5432');
    const user = this.settings.get('database.user', 'DB_USER', '');
    const pass = this.settings.get('database.password', 'DB_PASSWORD', '');
    const name = this.settings.get('database.name', 'DB_NAME', '');
    if (!user || !name) return null;
    const auth = pass ? `${user}:${pass}` : user;
    return `postgresql://${auth}@${host}:${port}/${name}`;
  }

  /** Fallback: hardcoded servers matching previous behavior (safety net) */
  private getFallbackServers(role: AgentRole, context: McpRuntimeContext): McpServerConfig[] {
    if (role === AgentRole.CODER) {
      return [
        {
          name: 'filesystem',
          command: 'npx',
          args: ['@modelcontextprotocol/server-filesystem', ...(context.allowedPaths || [context.workspace])],
        },
        {
          name: 'shell',
          command: 'node',
          args: [SHELL_SERVER_PATH, context.workspace],
        },
      ];
    }
    return [];
  }

  // ─── Seeding ────────────────────────────────────────────────

  private async seedBuiltinServers() {
    const builtins: {
      name: string;
      displayName: string;
      description: string;
      category: string;
      command: string;
      args: string[];
      argTemplate?: string;
      env?: Record<string, string>;
      envTemplate?: Record<string, string>;
      defaultRoles: AgentRole[];
    }[] = [
      // ─── Coding ──────────────────────
      {
        name: 'filesystem',
        displayName: 'Filesystem Server',
        description: 'Read, write, and search files in allowed directories',
        category: 'coding',
        command: 'npx',
        args: ['@modelcontextprotocol/server-filesystem'],
        argTemplate: '{allowedPaths}',
        defaultRoles: [
          AgentRole.ARCHITECT,
          AgentRole.CODER,
          AgentRole.CODE_REVIEWER,
          AgentRole.DOCUMENTER,
          AgentRole.FUNCTIONAL_TESTER,
          AgentRole.UI_TESTER,
          AgentRole.PEN_TESTER,
          AgentRole.DEVOPS,
        ],
      },
      {
        name: 'git',
        displayName: 'Git Server',
        description: 'Git operations: status, diff, log, branch, commit, merge',
        category: 'coding',
        command: 'npx',
        args: ['@cyanheads/git-mcp-server'],
        defaultRoles: [
          AgentRole.CODER,
          AgentRole.CODE_REVIEWER,
          AgentRole.DOCUMENTER,
          AgentRole.DEVOPS,
        ],
      },
      {
        name: 'gitlab',
        displayName: 'GitLab Server',
        description: 'GitLab API: issues, merge requests, pipelines, repos',
        category: 'coding',
        command: 'npx',
        args: ['@modelcontextprotocol/server-gitlab'],
        envTemplate: {
          GITLAB_PERSONAL_ACCESS_TOKEN: '{settings:gitlab.api_token}',
          GITLAB_API_URL: '{settings:gitlab.url}',
        },
        defaultRoles: [
          AgentRole.CODER,
          AgentRole.CODE_REVIEWER,
          AgentRole.DEVOPS,
        ],
      },
      {
        name: 'prisma',
        displayName: 'Prisma Server',
        description: 'Prisma schema analysis, migration, and query help',
        category: 'coding',
        command: 'npx',
        args: ['prisma', 'mcp'],
        defaultRoles: [AgentRole.CODER, AgentRole.ARCHITECT],
      },
      {
        name: 'angular-cli',
        displayName: 'Angular CLI MCP',
        description: 'Angular CLI: generate, build, schematics, best practices',
        category: 'coding',
        command: 'npx',
        args: ['@angular/cli', 'mcp'],
        defaultRoles: [AgentRole.CODER],
      },

      // ─── Java / Vaadin / Spring ─────
      {
        name: 'vaadin',
        displayName: 'Vaadin MCP',
        description: 'Vaadin Flow documentation, component examples, best practices (official remote server)',
        category: 'coding',
        command: '',
        args: [],
        argTemplate: 'https://mcp.vaadin.com/',
        defaultRoles: [AgentRole.CODER, AgentRole.ARCHITECT],
      },
      {
        name: 'spring-docs',
        displayName: 'Spring Docs MCP',
        description: 'Spring Boot, Spring Data JPA, Spring Security documentation and guides',
        category: 'coding',
        command: 'npx',
        args: ['-y', '@enokdev/springdocs-mcp@latest'],
        defaultRoles: [AgentRole.CODER, AgentRole.ARCHITECT],
      },

      // ─── Execution ──────────────────
      {
        name: 'shell',
        displayName: 'Shell Server',
        description: 'Sandboxed command execution (npm, git, node, etc.)',
        category: 'execution',
        command: 'node',
        args: [],
        argTemplate: '{shellServerPath} {workspace}',
        defaultRoles: [
          AgentRole.CODER,
          AgentRole.FUNCTIONAL_TESTER,
          AgentRole.UI_TESTER,
          AgentRole.PEN_TESTER,
          AgentRole.DEVOPS,
        ],
      },
      {
        name: 'playwright',
        displayName: 'Playwright Server',
        description: 'Browser automation: navigate, screenshot, interact, test',
        category: 'execution',
        command: 'npx',
        args: ['@playwright/mcp@latest'],
        defaultRoles: [AgentRole.UI_TESTER, AgentRole.FUNCTIONAL_TESTER],
      },
      {
        name: 'eslint',
        displayName: 'ESLint Server',
        description: 'Lint analysis, rule inspection, auto-fix suggestions',
        category: 'execution',
        command: 'npx',
        args: ['@eslint/mcp@latest'],
        defaultRoles: [AgentRole.CODER, AgentRole.CODE_REVIEWER],
      },

      // ─── Security ──────────────────
      {
        name: 'security-audit',
        displayName: 'Security Audit Server',
        description: 'npm audit, CVE lookup, dependency vulnerability scan',
        category: 'security',
        command: 'npx',
        args: ['@qianniuspace/mcp-security-audit@latest'],
        defaultRoles: [AgentRole.PEN_TESTER],
      },

      // ─── Infrastructure ──────────────
      {
        name: 'postgres',
        displayName: 'PostgreSQL Server',
        description: 'Database schema inspection and read-only SQL queries',
        category: 'coding',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-postgres'],
        argTemplate: '{postgresConnectionString}',
        defaultRoles: [AgentRole.CODER, AgentRole.ARCHITECT],
      },
      {
        name: 'docker',
        displayName: 'Docker Server',
        description: 'Docker container management: list, inspect, logs, exec',
        category: 'execution',
        command: 'npx',
        args: ['-y', 'mcp-server-docker'],
        defaultRoles: [AgentRole.DEVOPS],
      },

      // ─── Reasoning & Knowledge ────────
      {
        name: 'sequential-thinking',
        displayName: 'Sequential Thinking',
        description: 'Structured step-by-step reasoning for complex problem solving and debugging',
        category: 'knowledge',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
        defaultRoles: [AgentRole.ARCHITECT, AgentRole.CODER, AgentRole.CODE_REVIEWER],
      },
      {
        name: 'memory',
        displayName: 'Memory (Knowledge Graph)',
        description: 'Persistent knowledge graph for entities and relationships across sessions',
        category: 'knowledge',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-memory'],
        defaultRoles: [AgentRole.ARCHITECT, AgentRole.DOCUMENTER],
      },

      // ─── Web & Search ────────────────
      {
        name: 'searxng',
        displayName: 'SearXNG Search',
        description: 'Privacy-respecting web search via local SearXNG instance. Find documentation, examples, best practices, and solutions.',
        category: 'knowledge',
        command: 'npx',
        args: ['-y', 'mcp-searxng'],
        envTemplate: {
          SEARXNG_URL: '{settings:search.searxng_url}',
        },
        defaultRoles: [AgentRole.ARCHITECT],
      },
    ];

    for (const def of builtins) {
      const existing = await this.prisma.mcpServerDefinition.findUnique({
        where: { name: def.name },
      });

      if (!existing) {
        const server = await this.prisma.mcpServerDefinition.create({
          data: {
            name: def.name,
            displayName: def.displayName,
            description: def.description,
            category: def.category,
            command: def.command,
            args: def.args,
            argTemplate: def.argTemplate,
            envTemplate: def.envTemplate ?? undefined,
            builtin: true,
            enabled: true,
          },
        });

        for (const role of def.defaultRoles) {
          await this.prisma.mcpServerOnRole.create({
            data: { mcpServerId: server.id, agentRole: role },
          });
        }
        this.logger.log(`Seeded built-in MCP server: ${def.name} → [${def.defaultRoles.join(', ')}]`);
      } else {
        // Update existing builtin server envTemplate if it was added
        if (def.envTemplate && !existing.envTemplate) {
          await this.prisma.mcpServerDefinition.update({
            where: { id: existing.id },
            data: { envTemplate: def.envTemplate },
          });
          this.logger.log(`Updated envTemplate for built-in server: ${def.name}`);
        }
      }
    }
  }
}
