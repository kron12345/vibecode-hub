/** MCP module types */

/** Configuration for a single MCP server */
export interface McpServerConfig {
  /** Unique name for this server (e.g., 'filesystem', 'git') */
  name: string;
  /** Command to start the server */
  command: string;
  /** Arguments for the command */
  args: string[];
  /** Environment variables for the server process */
  env?: Record<string, string>;
}

/** Predefined MCP server configurations */
export const MCP_SERVERS = {
  /** Filesystem server — read/write/search files in allowed directories */
  filesystem: (allowedPaths: string[]): McpServerConfig => ({
    name: 'filesystem',
    command: 'npx',
    args: ['@modelcontextprotocol/server-filesystem', ...allowedPaths],
  }),
} as const;

/** Result of a completed agent loop */
export interface McpAgentLoopResult {
  /** Final text content from the LLM */
  content: string;
  /** How many LLM round-trips were made */
  iterations: number;
  /** Total number of tool calls executed */
  toolCallsExecuted: number;
  /** Total duration in ms */
  durationMs: number;
  /** Why the loop ended */
  finishReason: 'complete' | 'max_iterations' | 'timeout' | 'error';
}

/** Options for running the agent loop */
export interface McpAgentLoopOptions {
  /** LLM provider type (e.g., 'OLLAMA') */
  provider: string;
  /** Model name (e.g., 'qwen3.5:35b') */
  model: string;
  /** System prompt for the LLM */
  systemPrompt: string;
  /** User prompt (the task) */
  userPrompt: string;
  /** MCP servers to connect */
  mcpServers: McpServerConfig[];
  /** Max LLM round-trips before stopping (default: 30) */
  maxIterations?: number;
  /** Total timeout in ms (default: 10 min) */
  timeoutMs?: number;
  /** LLM temperature */
  temperature?: number;
  /** LLM max tokens per response */
  maxTokens?: number;
  /** Called on each tool execution */
  onToolCall?: (name: string, args: Record<string, unknown>, result: string) => void;
  /** Called on each LLM iteration */
  onIteration?: (iteration: number, content: string) => void;
}
