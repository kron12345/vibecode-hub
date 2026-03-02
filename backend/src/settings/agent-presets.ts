/**
 * Agent role presets — shared between seed script and API.
 *
 * Each preset defines provider/model/temperature per role.
 * System prompts, permissions, and metadata are NOT included here
 * (they stay as-is when switching presets).
 */

export interface PresetOverride {
  provider: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

export interface AgentPreset {
  name: string;
  description: string;
  icon: string;
  roles: Record<string, PresetOverride>;
}

export const AGENT_PRESETS: Record<string, AgentPreset> = {
  local: {
    name: 'Local (Ollama)',
    description: '3 core models optimized for 2×3090 / 48GB VRAM. Max quality, no API costs.',
    icon: 'hard-drive',
    roles: {
      INTERVIEWER:       { provider: 'OLLAMA', model: 'qwen3.5:35b',      temperature: 0.7, maxTokens: 4096 },
      ARCHITECT:         { provider: 'OLLAMA', model: 'deepseek-r1:32b',  temperature: 0.5, maxTokens: 4096 },
      ISSUE_COMPILER:    { provider: 'OLLAMA', model: 'qwen3.5:35b',      temperature: 0.3, maxTokens: 4096 },
      CODER:             { provider: 'OLLAMA', model: 'qwen3-coder:30b',  temperature: 0.2, maxTokens: 8192 },
      CODE_REVIEWER:     { provider: 'OLLAMA', model: 'deepseek-r1:32b',  temperature: 0.1, maxTokens: 4096 },
      UI_TESTER:         { provider: 'OLLAMA', model: 'qwen3-coder:30b',  temperature: 0.2, maxTokens: 4096 },
      FUNCTIONAL_TESTER: { provider: 'OLLAMA', model: 'qwen3-coder:30b',  temperature: 0.1, maxTokens: 4096 },
      PEN_TESTER:        { provider: 'OLLAMA', model: 'deepseek-r1:32b',  temperature: 0.1, maxTokens: 4096 },
      DOCUMENTER:        { provider: 'OLLAMA', model: 'qwen3.5:35b',      temperature: 0.3, maxTokens: 4096 },
      DEVOPS:            { provider: 'OLLAMA', model: 'qwen3-coder:30b',  temperature: 0.1, maxTokens: 4096 },
    },
  },

  cli: {
    name: 'CLI Tools',
    description: 'Claude Code, Codex CLI & Qwen3 Coder. Remote API via CLI subprocesses.',
    icon: 'terminal',
    roles: {
      INTERVIEWER:       { provider: 'CLAUDE_CODE',  model: 'claude-sonnet-4-6', temperature: 0.7, maxTokens: 4096 },
      ARCHITECT:         { provider: 'CLAUDE_CODE',  model: 'claude-sonnet-4-6', temperature: 0.5, maxTokens: 4096 },
      ISSUE_COMPILER:    { provider: 'CLAUDE_CODE',  model: 'claude-sonnet-4-6', temperature: 0.3, maxTokens: 4096 },
      CODER:             { provider: 'CODEX_CLI',    model: 'o4-mini',           temperature: 0.2, maxTokens: 8192 },
      CODE_REVIEWER:     { provider: 'CLAUDE_CODE',  model: 'claude-sonnet-4-6', temperature: 0.1, maxTokens: 4096 },
      UI_TESTER:         { provider: 'QWEN3_CODER',  model: 'qwen3-coder',      temperature: 0.2, maxTokens: 4096 },
      FUNCTIONAL_TESTER: { provider: 'CODEX_CLI',    model: 'o4-mini',           temperature: 0.1, maxTokens: 4096 },
      PEN_TESTER:        { provider: 'CLAUDE_CODE',  model: 'claude-sonnet-4-6', temperature: 0.1, maxTokens: 4096 },
      DOCUMENTER:        { provider: 'CLAUDE_CODE',  model: 'claude-sonnet-4-6', temperature: 0.3, maxTokens: 4096 },
      DEVOPS:            { provider: 'CODEX_CLI',    model: 'o4-mini',           temperature: 0.1, maxTokens: 4096 },
    },
  },
};
