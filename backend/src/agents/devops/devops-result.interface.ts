/** Structured output from the DevOps agent setup process */
export interface DevopsSetupResult {
  workspacePath: string;
  cloneSuccess: boolean;
  initCommandResult: CommandResult | null;
  additionalCommandResults: CommandResult[];
  mcpConfigGenerated: boolean;
  gitPushSuccess: boolean;
  webhookConfigured: boolean;
  steps: SetupStep[];
}

export interface CommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SetupStep {
  name: string;
  status: 'success' | 'failed' | 'skipped';
  message: string;
  durationMs: number;
}
