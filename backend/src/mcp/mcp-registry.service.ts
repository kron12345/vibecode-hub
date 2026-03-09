import { Injectable, Logger, OnModuleInit, NotFoundException, BadRequestException } from '@nestjs/common';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { AgentRole, McpServerDefinition } from '@prisma/client';
import { McpServerConfig } from './mcp.interfaces';
import { CreateMcpServerDto, UpdateMcpServerDto } from './mcp-registry.dto';

/** Runtime context passed when resolving MCP servers for an agent */
export interface McpRuntimeContext {
  workspace: string;
  allowedPaths?: string[];
}

/** Shell server .mjs path (relative to compiled dist output) */
const SHELL_SERVER_PATH = path.resolve(__dirname, '..', '..', 'mcp', 'servers', 'shell-server.mjs');

@Injectable()
export class McpRegistryService implements OnModuleInit {
  private readonly logger = new Logger(McpRegistryService.name);

  constructor(private readonly prisma: PrismaService) {}

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

    // Replace all role assignments for this server
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

  // ─── Resolution (DB → McpServerConfig[]) ────────────────────

  /**
   * Resolve MCP server definitions for a given agent role into
   * ready-to-use McpServerConfig objects with runtime args filled in.
   */
  async resolveServersForRole(
    role: AgentRole,
    context: McpRuntimeContext,
  ): Promise<McpServerConfig[]> {
    const servers = await this.getServersForRole(role);

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
        } else {
          // Literal arg from template
          resolvedArgs.push(part);
        }
      }
    }

    return {
      name: server.name,
      command: server.command,
      args: resolvedArgs,
      env: (server.env as Record<string, string>) || undefined,
    };
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
    const builtins = [
      {
        name: 'filesystem',
        displayName: 'Filesystem Server',
        description: 'Read, write, and search files in allowed directories',
        category: 'coding',
        command: 'npx',
        args: ['@modelcontextprotocol/server-filesystem'],
        argTemplate: '{allowedPaths}',
        defaultRoles: [AgentRole.CODER],
      },
      {
        name: 'shell',
        displayName: 'Shell Server',
        description: 'Sandboxed command execution (npm, git, node, etc.)',
        category: 'execution',
        command: 'node',
        args: [] as string[],
        argTemplate: '{shellServerPath} {workspace}',
        defaultRoles: [AgentRole.CODER],
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
            builtin: true,
            enabled: true,
          },
        });

        // Create default role assignments
        for (const role of def.defaultRoles) {
          await this.prisma.mcpServerOnRole.create({
            data: { mcpServerId: server.id, agentRole: role },
          });
        }
        this.logger.log(`Seeded built-in MCP server: ${def.name} → [${def.defaultRoles.join(', ')}]`);
      }
    }
  }
}
