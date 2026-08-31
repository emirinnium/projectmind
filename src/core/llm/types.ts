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
}

export interface LLMConfig {
  provider: string;
  model: string;
  apiKey?: string;
  deepModel?: string;
  apiUrl?: string;
  timeoutMs?: number;
  maxTokens?: number;
}

export const DEFAULT_MAX_TOKENS = 4000;

export const DEFAULT_TIMEOUT_MS = 30_000;

export const DEFAULT_DIMENSION = 768;