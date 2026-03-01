/** Shared types for the LLM abstraction layer */

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LlmCompletionOptions {
  provider: string;
  model: string;
  messages: LlmMessage[];
  temperature?: number;
  maxTokens?: number;
  tools?: LlmToolDefinition[];
}

export interface LlmCompletionResult {
  content: string;
  finishReason: 'stop' | 'length' | 'tool_calls' | 'error';
  toolCalls?: LlmToolCall[];
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface LlmStreamChunk {
  content: string;
  done: boolean;
}

export interface LlmProvider {
  readonly providerType: string;
  complete(options: LlmCompletionOptions): Promise<LlmCompletionResult>;
}
