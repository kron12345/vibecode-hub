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
  /** Secondary provider for dual-testing (optional) */
  dualProvider?: string;
  /** Secondary model for dual-testing */
  dualModel?: string;
  /**
   * Dual-testing strategy:
   * - 'merge': combine findings from both providers (union, deduplicated)
   * - 'consensus': only keep findings both providers agree on (intersection)
   * - 'enrich': primary runs first, secondary enriches/validates primary's output
   */
  dualStrategy?: 'merge' | 'consensus' | 'enrich';
}

export interface AgentPreset {
  name: string;
  description: string;
  icon: string;
  roles: Record<string, PresetOverride>;
}

export const AGENT_PRESETS: Record<string, AgentPreset> = {
  // ─── Local Only (Ollama) ──────────────────────────────────
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

  // ─── CLI Tools (Cloud Subscriptions) ──────────────────────
  // Codex Pro (unlimited) + Claude Max + Gemini Pro (free/Pro)
  // No API keys needed — uses CLI subscription auth.
  cli: {
    name: 'CLI Tools (Cloud)',
    description: 'Codex Pro (unlimited) + Claude Max + Gemini Pro. Subscription-based, no API keys.',
    icon: 'terminal',
    roles: {
      // ── Planning & Design ──
      // Claude Haiku: fast, cheap on Max budget — simple conversational task
      INTERVIEWER:       { provider: 'CLAUDE_CODE',  model: 'haiku',            temperature: 0.7, maxTokens: 4096 },
      // Claude Opus: best reasoning for complex architecture decisions, 1M context
      ARCHITECT:         { provider: 'CLAUDE_CODE',  model: 'opus',             temperature: 0.5, maxTokens: 8192 },
      // Codex: unlimited, structured text output — no reason to save here
      ISSUE_COMPILER:    { provider: 'CODEX_CLI',    model: 'codex-mini-latest', temperature: 0.3, maxTokens: 4096 },

      // ── Implementation ──
      // Codex GPT-5.3: Terminal-Bench #1, unlimited, specialized for code generation
      CODER:             { provider: 'CODEX_CLI',    model: 'gpt-5.3-codex',    temperature: 0.2, maxTokens: 16384 },
      // DevOps: shell ops, project setup — Codex unlimited, mini is fast enough
      DEVOPS:            { provider: 'CODEX_CLI',    model: 'codex-mini-latest', temperature: 0.1, maxTokens: 4096 },

      // ── Review & Testing (with Dual-Testing) ──
      // Code Review: Codex primary (unlimited + security-focused), Claude secondary
      CODE_REVIEWER:     { provider: 'CODEX_CLI',    model: 'gpt-5.3-codex',    temperature: 0.1, maxTokens: 8192,
                           dualProvider: 'CLAUDE_CODE', dualModel: 'sonnet', dualStrategy: 'merge' },
      // Functional Tester: Codex unlimited, strong at structured test analysis
      FUNCTIONAL_TESTER: { provider: 'CODEX_CLI',    model: 'gpt-5.3-codex',    temperature: 0.1, maxTokens: 8192 },
      // UI Tester: Gemini primary (multimodal screenshots!), Claude secondary (code analysis)
      UI_TESTER:         { provider: 'GEMINI_CLI',   model: 'gemini-2.5-pro',   temperature: 0.2, maxTokens: 4096,
                           dualProvider: 'CLAUDE_CODE', dualModel: 'haiku', dualStrategy: 'merge' },
      // Pen Tester: Codex primary (500+ 0-day track record), Claude Opus secondary — consensus to reduce false positives
      PEN_TESTER:        { provider: 'CODEX_CLI',    model: 'gpt-5.3-codex',    temperature: 0.1, maxTokens: 8192,
                           dualProvider: 'CLAUDE_CODE', dualModel: 'opus', dualStrategy: 'consensus' },

      // ── Documentation ──
      // Codex mini: unlimited, fast, docs are straightforward
      DOCUMENTER:        { provider: 'CODEX_CLI',    model: 'codex-mini-latest', temperature: 0.3, maxTokens: 8192 },
    },
  },
};
