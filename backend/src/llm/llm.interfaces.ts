/** Shared types for the LLM abstraction layer */

/** A single part of a multimodal message content. */
export type LlmContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; base64: string };

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** Text-only content (string) or multimodal content (array of text/image parts). */
  content: string | LlmContentPart[];
  /** Tool calls requested by the assistant (only for role='assistant') */
  toolCalls?: LlmToolCall[];
  /** Identifies which tool call this result belongs to (only for role='tool') */
  toolCallId?: string;
}

/**
 * Extract the text content from a message, regardless of whether it's
 * a plain string or a multimodal content array.
 */
export function getTextContent(content: string | LlmContentPart[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p): p is Extract<LlmContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

/**
 * Extract image parts from multimodal content.
 * Returns empty array for plain string content.
 */
export function getImageParts(
  content: string | LlmContentPart[],
): Array<Extract<LlmContentPart, { type: 'image' }>> {
  if (typeof content === 'string') return [];
  return content.filter(
    (p): p is Extract<LlmContentPart, { type: 'image' }> => p.type === 'image',
  );
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
  /** Working directory for CLI-based providers */
  cwd?: string;
  /** Custom timeout in ms (default: provider-specific, e.g. 600s for Ollama) */
  timeoutMs?: number;
  /** Enable chain-of-thought reasoning (Ollama think mode for qwen3.5, deepseek-r1, etc.) */
  enableReasoning?: boolean;
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

/** Provider that supports token-by-token streaming */
export interface LlmStreamingProvider extends LlmProvider {
  streamComplete(options: LlmCompletionOptions): AsyncGenerator<LlmStreamChunk>;
}

/** Type guard to check if a provider supports streaming */
export function isStreamingProvider(provider: LlmProvider): provider is LlmStreamingProvider {
  return 'streamComplete' in provider && typeof (provider as any).streamComplete === 'function';
}
