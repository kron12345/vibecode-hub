import type { DualTestStrategy } from './enums';

// ─── System Settings ──────────────────────────────────────────

export interface SystemSetting {
  key: string;
  value: string;
  category: string;
  encrypted: boolean;
  description: string | null;
}

export type UserSettings = Record<string, unknown>;

// ─── Agent Role Config ────────────────────────────────────────

export interface AgentRoleConfig {
  provider: string;
  model: string;
  systemPrompt: string;
  parameters: {
    temperature: number;
    maxTokens: number;
    topP?: number;
  };
  permissions: {
    fileRead: boolean;
    fileWrite: boolean;
    terminal: boolean;
    installPackages: boolean;
    http: boolean;
    gitOperations: boolean;
  };
  pipelinePosition: number;
  enableReasoning?: boolean;
  dualProvider?: string;
  dualModel?: string;
  dualStrategy?: DualTestStrategy;
  description: string;
  color: string;
  icon: string;
}

export interface AgentPresetInfo {
  id: string;
  name: string;
  description: string;
  icon: string;
}

// ─── Pipeline Config ──────────────────────────────────────────

export interface PipelineConfig {
  enabled: boolean;
  autoStart: boolean;
  requireApproval: boolean;
  maxConcurrentAgents: number;
  timeoutMinutes: number;
  maxParallelOllamaModels: number;
  maxFixAttempts: number;
  mcpMaxIterations?: number;
  maxInterviewMessages?: number;
  stuckCheckIntervalMinutes?: number;
  gitTimeoutSeconds?: number;
  cliTimeoutMinutes?: number;
  maxReviewDiffs?: number;
}

// ─── MCP Server ───────────────────────────────────────────────

export interface McpServerDefinition {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  category: string;
  command: string;
  args: string[];
  env: Record<string, string> | null;
  argTemplate: string | null;
  builtin: boolean;
  enabled: boolean;
  roles: string[];
}

export interface McpProjectOverride {
  id: string;
  projectId: string;
  mcpServerId: string;
  agentRole: string;
  action: 'ENABLE' | 'DISABLE';
  mcpServer?: { id: string; name: string; displayName: string };
}

// ─── Provider Discovery ──────────────────────────────────────

export interface ProviderModel {
  name: string;
  displayName?: string;
  size?: number;
  parameterSize?: string;
  quantization?: string;
}

export interface ProviderModelsResult {
  provider: string;
  available: boolean;
  models: ProviderModel[];
  error?: string;
}

export interface CliToolStatus {
  name: string;
  command: string;
  installed: boolean;
  version?: string;
}
