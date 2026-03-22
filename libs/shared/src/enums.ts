// ─── Project ──────────────────────────────────────────────────
export type ProjectStatus = 'INTERVIEWING' | 'SETTING_UP' | 'READY' | 'ARCHIVED';

// ─── Issue ────────────────────────────────────────────────────
export type IssueStatus =
  | 'OPEN'
  | 'IN_PROGRESS'
  | 'IN_REVIEW'
  | 'TESTING'
  | 'NEEDS_REVIEW'
  | 'DONE'
  | 'CLOSED';

export type IssuePriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type CommentAuthorType = 'AGENT' | 'USER' | 'SYSTEM';

// ─── Chat ─────────────────────────────────────────────────────
export type ChatSessionType = 'INFRASTRUCTURE' | 'DEV_SESSION';

export type SessionStatus = 'ACTIVE' | 'MERGING' | 'ARCHIVED' | 'CONFLICT';

export type MessageRole = 'USER' | 'ASSISTANT' | 'SYSTEM' | 'AGENT';

// ─── Agent ────────────────────────────────────────────────────
export type AgentRole =
  | 'INTERVIEWER'
  | 'ARCHITECT'
  | 'ISSUE_COMPILER'
  | 'CODER'
  | 'CODE_REVIEWER'
  | 'UI_TESTER'
  | 'FUNCTIONAL_TESTER'
  | 'PEN_TESTER'
  | 'DOCUMENTER'
  | 'DEVOPS';

export type AgentStatus = 'IDLE' | 'WORKING' | 'WAITING' | 'ERROR' | 'OFFLINE';

export type AgentTaskType =
  | 'INTERVIEW'
  | 'FEATURE_INTERVIEW'
  | 'DESIGN_ARCHITECTURE'
  | 'ANALYZE_ISSUES'
  | 'CREATE_ISSUES'
  | 'WRITE_CODE'
  | 'REVIEW_CODE'
  | 'TEST_UI'
  | 'TEST_FUNCTIONAL'
  | 'TEST_SECURITY'
  | 'WRITE_DOCS'
  | 'FIX_CODE'
  | 'DEPLOY'
  | 'INFRA_COMMAND'
  | 'RESOLVE_LOOP';

export type AgentTaskStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'WAITING_FOR_INPUT';

// ─── Message Visibility ───────────────────────────────────────
export type MessageVisibility = 'USER_FACING' | 'AGENT_INTERNAL';

// ─── LLM ──────────────────────────────────────────────────────
export type LLMProvider =
  | 'OLLAMA'
  | 'CLAUDE_CODE'
  | 'CODEX_CLI'
  | 'GEMINI_CLI'
  | 'QWEN3_CODER'
  | 'ANTHROPIC'
  | 'OPENAI'
  | 'GOOGLE';

// ─── MCP ──────────────────────────────────────────────────────
export type McpOverrideAction = 'ENABLE' | 'DISABLE';

// ─── Settings ─────────────────────────────────────────────────
export type DualTestStrategy = 'merge' | 'consensus' | 'enrich';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
