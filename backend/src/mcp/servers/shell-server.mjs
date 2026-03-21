/**
 * MCP Shell Server — sandboxed command execution.
 *
 * Provides a `run_command` tool that executes whitelisted commands
 * inside a specified workspace directory.
 *
 * Usage: node shell-server.mjs <workspace-path>
 *
 * Security:
 * - Only whitelisted binaries (npm, git, node, etc.)
 * - Commands run via execFile (no shell interpretation)
 * - Working directory locked to workspace
 * - 120s timeout per command
 * - 10 MB output buffer limit
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';

const execFileAsync = promisify(execFile);

const workspace = process.argv[2];
if (!workspace || !existsSync(workspace)) {
  console.error(`Error: workspace directory "${workspace}" does not exist`);
  process.exit(1);
}

/** Whitelisted commands the LLM may execute */
const ALLOWED_COMMANDS = new Set([
  // Package managers
  'npm', 'npx', 'yarn', 'pnpm',
  // Runtime
  'node', 'python3', 'python',
  // Version control
  'git',
  // File inspection (read-only)
  'ls', 'cat', 'head', 'tail', 'find', 'grep', 'wc', 'sort', 'uniq', 'diff',
  'tree', 'file', 'stat', 'du',
  // File manipulation
  'mkdir', 'cp', 'mv', 'touch', 'chmod',
  // Text processing
  'sed', 'awk', 'tr', 'cut',
  // Misc
  'echo', 'pwd', 'which', 'env', 'date',
  // Build tools
  'make', 'cargo', 'go', 'tsc', 'ng',
  // Java/Maven
  'mvn', 'gradle', 'java', 'javac',
]);

/** Commands that are completely blocked (even if whitelisted parent is OK) */
const BLOCKED_PATTERNS = [
  /\brm\b.*-rf?\b.*\//,  // rm -rf with path
  /\bsudo\b/,
  /\bcurl\b.*\|.*\bsh\b/,
  /\bwget\b.*\|.*\bsh\b/,
];

/**
 * Parse a command string into binary + args.
 * Handles simple quoting (no shell expansion, pipes, or redirects).
 */
function parseCommand(cmd) {
  const tokens = [];
  let current = '';
  let inQuote = false;
  let quoteChar = '';

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (inQuote) {
      if (ch === quoteChar) {
        inQuote = false;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = true;
      quoteChar = ch;
    } else if (ch === ' ' || ch === '\t') {
      if (current) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);

  return { binary: tokens[0] || '', args: tokens.slice(1) };
}

// ─── MCP Server Setup ──────────────────────────────────────

const server = new Server(
  { name: 'shell', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

// List tools
server.setRequestHandler(
  ListToolsRequestSchema,
  async () => ({
    tools: [
      {
        name: 'run_command',
        description: [
          'Execute a shell command in the project workspace directory.',
          'Use this for: npm install, npm audit fix, git operations, running build/test scripts.',
          `Allowed commands: ${[...ALLOWED_COMMANDS].slice(0, 20).join(', ')}, ...`,
          'Commands run in the workspace root. No pipes or redirects.',
        ].join(' '),
        inputSchema: {
          type: 'object',
          properties: {
            command: {
              type: 'string',
              description: 'The command to execute (e.g., "npm install", "npm audit fix", "git status")',
            },
          },
          required: ['command'],
        },
      },
    ],
  }),
);

// Execute tool calls
server.setRequestHandler(
  CallToolRequestSchema,
  async (request) => {
    const { name, arguments: args } = request.params;

    if (name !== 'run_command') {
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    const rawCommand = args?.command;
    if (!rawCommand || typeof rawCommand !== 'string') {
      return {
        content: [{ type: 'text', text: 'Error: "command" parameter is required' }],
        isError: true,
      };
    }

    // Block dangerous patterns
    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(rawCommand)) {
        return {
          content: [{ type: 'text', text: `Blocked: command matches dangerous pattern` }],
          isError: true,
        };
      }
    }

    const { binary, args: cmdArgs } = parseCommand(rawCommand);

    if (!ALLOWED_COMMANDS.has(binary)) {
      return {
        content: [{
          type: 'text',
          text: `Command "${binary}" is not allowed.\nAllowed: ${[...ALLOWED_COMMANDS].join(', ')}`,
        }],
        isError: true,
      };
    }

    try {
      const { stdout, stderr } = await execFileAsync(binary, cmdArgs, {
        cwd: workspace,
        timeout: 120_000,
        maxBuffer: 10 * 1024 * 1024,
        env: {
          ...process.env,
          HOME: process.env.HOME,
          PATH: process.env.PATH,
          NODE_ENV: 'development',
        },
      });

      const output = [
        stdout ? stdout.trimEnd() : '',
        stderr ? `\n--- stderr ---\n${stderr.trimEnd()}` : '',
      ].join('');

      return {
        content: [{ type: 'text', text: output || '(no output)' }],
      };
    } catch (err) {
      const exitCode = err.code ?? 'unknown';
      const output = [
        err.stdout ? err.stdout.trimEnd() : '',
        err.stderr ? `\n--- stderr ---\n${err.stderr.trimEnd()}` : '',
        `\nExit code: ${exitCode}`,
      ].join('');

      return {
        content: [{ type: 'text', text: output || `Error: ${err.message}` }],
        isError: true,
      };
    }
  },
);

// Start
const transport = new StdioServerTransport();
await server.connect(transport);
