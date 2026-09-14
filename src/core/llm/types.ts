export interface LLMProvider {
  name: string;
  model: string;
  isAvailable(): boolean;
  analyze(prompt: string, systemPrompt?: string, temperature?: number): Promise<LLMResponse>;
}

export interface LLMResponse {
  content: string;
  reasoningTrace: string[];
  confidence: number;
  usage?: { inputTokens: number; outputTokens: number };
  responseTimeMs: number;
  /** Machine-readable response shape; reasoning is never exposed as final content. */
  responseMode?: 'content' | 'reasoning-only' | 'empty';
  /** Provider termination reason, when the provider supplies one. */
  finishReason?: string;
}

export interface LLMConfig {
  provider: string;
  model: string;
  apiKey?: string;
  deepModel?: string;
  apiUrl?: string;
  timeoutMs?: number;
  maxTokens?: number;
  /** OpenRouter-compatible reasoning controls; omitted means provider default. */
  reasoning?: {
    effort?: 'xhigh' | 'high' | 'medium' | 'low' | 'minimal' | 'none';
    maxTokens?: number;
    exclude?: boolean;
  };
}

export const DEFAULT_MAX_TOKENS = 4000;

export const DEFAULT_TIMEOUT_MS = 30_000;

export const DEFAULT_DIMENSION = 768;
