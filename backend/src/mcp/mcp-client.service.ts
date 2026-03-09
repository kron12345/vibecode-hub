import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { LlmToolDefinition } from '../llm/llm.interfaces';
import { McpServerConfig } from './mcp.interfaces';

/** A live connection to an MCP server */
interface McpConnection {
  name: string;
  client: any; // MCP Client instance (ESM import)
  transport: any; // StdioClientTransport instance
  tools: LlmToolDefinition[];
}

/** A session groups multiple MCP server connections */
interface McpSession {
  id: string;
  connections: McpConnection[];
}

@Injectable()
export class McpClientService implements OnModuleDestroy {
  private readonly logger = new Logger(McpClientService.name);
  private readonly sessions = new Map<string, McpSession>();

  /** Cached ESM imports — loaded once */
  private sdkModule: any = null;

  async onModuleDestroy() {
    // Clean up all sessions on shutdown
    for (const sessionId of this.sessions.keys()) {
      await this.destroySession(sessionId);
    }
  }

  /**
   * Lazily load the MCP SDK (ESM-only package).
   * NestJS runs CJS, so we use dynamic import().
   */
  private async loadSdk() {
    if (!this.sdkModule) {
      const [clientMod, transportMod, typesMod] = await Promise.all([
        import('@modelcontextprotocol/sdk/client/index.js'),
        import('@modelcontextprotocol/sdk/client/stdio.js'),
        import('@modelcontextprotocol/sdk/types.js'),
      ]);
      this.sdkModule = { clientMod, transportMod, typesMod };
    }
    return this.sdkModule;
  }

  /**
   * Create a session with one or more MCP servers.
   * Starts each server as a subprocess and discovers available tools.
   */
  async createSession(configs: McpServerConfig[]): Promise<string> {
    const sdk = await this.loadSdk();
    const { Client } = sdk.clientMod;
    const { StdioClientTransport } = sdk.transportMod;
    const { ListToolsResultSchema } = sdk.typesMod;

    const sessionId = `mcp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const connections: McpConnection[] = [];

    for (const config of configs) {
      try {
        this.logger.log(`Starting MCP server: ${config.name} (${config.command} ${config.args.join(' ')})`);

        const transport = new StdioClientTransport({
          command: config.command,
          args: config.args,
          env: { ...process.env, ...config.env },
        });

        const client = new Client(
          { name: 'vibcode-hub', version: '1.0.0' },
          { capabilities: {} },
        );

        await client.connect(transport);

        // Discover tools
        const { tools: mcpTools } = await client.request(
          { method: 'tools/list' },
          ListToolsResultSchema,
        );

        // Filter out deprecated/unnecessary tools to reduce token overhead
        const EXCLUDED_TOOLS = new Set([
          'read_file',               // deprecated, use read_text_file
          'read_media_file',         // not needed for code tasks
          'list_directory_with_sizes', // redundant with list_directory
        ]);

        // Convert MCP tool schemas to our LlmToolDefinition format
        const tools: LlmToolDefinition[] = mcpTools
          .filter((t: any) => !EXCLUDED_TOOLS.has(t.name))
          .map((t: any) => ({
            name: t.name,
            description: t.description ?? '',
            parameters: this.stripSchemaKey(t.inputSchema ?? { type: 'object', properties: {} }),
          }));

        this.logger.log(
          `MCP server "${config.name}" connected — ${tools.length} tools: ${tools.map(t => t.name).join(', ')}`,
        );

        connections.push({ name: config.name, client, transport, tools });

      } catch (err) {
        this.logger.error(`Failed to start MCP server "${config.name}": ${err.message}`);
        // Don't fail the whole session — other servers might work
      }
    }

    if (connections.length === 0) {
      throw new Error('No MCP servers could be started');
    }

    this.sessions.set(sessionId, { id: sessionId, connections });
    this.logger.log(`MCP session ${sessionId} created — ${connections.length} server(s)`);
    return sessionId;
  }

  /**
   * Get all available tools from all servers in a session.
   */
  getTools(sessionId: string): LlmToolDefinition[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    return session.connections.flatMap((c) => c.tools);
  }

  /**
   * Execute a tool call on the appropriate MCP server.
   * Looks up which server owns the tool and calls it.
   */
  async callTool(
    sessionId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const sdk = await this.loadSdk();
    const { CallToolResultSchema } = sdk.typesMod;

    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`MCP session ${sessionId} not found`);

    // Find which connection owns this tool
    const connection = session.connections.find((c) =>
      c.tools.some((t) => t.name === toolName),
    );
    if (!connection) {
      return `Error: Tool "${toolName}" not found in any connected MCP server`;
    }

    try {
      const result = await connection.client.request(
        {
          method: 'tools/call',
          params: { name: toolName, arguments: args },
        },
        CallToolResultSchema,
      );

      // MCP returns content as array of {type, text} or {type, data}
      const textParts = (result.content ?? [])
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text);

      return textParts.join('\n') || '(empty result)';

    } catch (err) {
      this.logger.warn(`Tool "${toolName}" failed: ${err.message}`);
      return `Error executing tool "${toolName}": ${err.message}`;
    }
  }

  /**
   * Recursively strip $schema keys from JSON Schema objects.
   * Ollama's internal XML template parser chokes on these.
   */
  private stripSchemaKey(schema: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema)) {
      if (key === '$schema') continue;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        result[key] = this.stripSchemaKey(value as Record<string, unknown>);
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  /**
   * Destroy a session — stops all MCP servers and cleans up.
   */
  async destroySession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    for (const conn of session.connections) {
      try {
        await conn.transport.close();
        this.logger.debug(`MCP server "${conn.name}" stopped`);
      } catch (err) {
        this.logger.warn(`Error stopping MCP server "${conn.name}": ${err.message}`);
      }
    }

    this.sessions.delete(sessionId);
    this.logger.log(`MCP session ${sessionId} destroyed`);
  }
}
