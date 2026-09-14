import {
  LLMProvider,
  LLMResponse,
  LLMConfig,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_TOKENS,
} from './types.js';
import { validateApiUrl } from './url-validator.js';

export class OpenAIProvider implements LLMProvider {
  name: string;
  model: string;
  private apiKey: string;
  private apiUrl: string;
  private timeoutMs: number;
  private maxTokens: number;
  private reasoning: LLMConfig['reasoning'];

  constructor(config: LLMConfig) {
    this.name = config.provider || 'openai';
    this.model = config.model;
    this.apiKey = config.apiKey || '';
    const defaultUrl =
      this.name === 'openrouter' ? 'https://openrouter.ai/api/v1' : 'https://api.openai.com/v1';
    this.apiUrl = validateApiUrl(config.apiUrl || defaultUrl, this.name);
    this.timeoutMs = config.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.reasoning = config.reasoning;
  }

  isAvailable(): boolean {
    return !!this.apiKey;
  }

  async analyze(
    prompt: string,
    systemPrompt?: string,
    temperature: number = 0.3,
  ): Promise<LLMResponse> {
    if (!this.isAvailable()) {
      throw new Error(
        `${this.name === 'openrouter' ? 'OpenRouter' : 'OpenAI'} API key not configured`,
      );
    }

    const startTime = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const messages: { role: string; content: string }[] = [];
      if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
      }
      messages.push({ role: 'user', content: prompt });

      const reasoning =
        this.name === 'openrouter' && this.reasoning && Object.keys(this.reasoning).length > 0
          ? {
              ...(this.reasoning.effort ? { effort: this.reasoning.effort } : {}),
              ...(this.reasoning.maxTokens !== undefined
                ? { max_tokens: this.reasoning.maxTokens }
                : {}),
              ...(this.reasoning.exclude !== undefined ? { exclude: this.reasoning.exclude } : {}),
            }
          : undefined;
      const response = await fetch(`${this.apiUrl}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: this.maxTokens,
          temperature,
          messages,
          ...(reasoning ? { reasoning } : {}),
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        throw new Error(
          `${this.name === 'openrouter' ? 'OpenRouter' : 'OpenAI'} API error: ${response.status} ${err}`,
        );
      }

      interface OpenAIChoice {
        finish_reason?: string;
        message?: {
          content?: string | null;
          reasoning?: unknown;
          reasoning_details?: unknown;
        };
      }
      interface OpenAIResponse {
        choices?: OpenAIChoice[];
        usage?: { prompt_tokens: number; completion_tokens: number };
      }
      const data = (await response.json()) as OpenAIResponse;
      const choice = data.choices?.[0];
      const rawContent = choice?.message?.content;
      const content = typeof rawContent === 'string' ? rawContent : '';
      const hasReasoning =
        hasProviderReasoning(choice?.message?.reasoning) ||
        hasProviderReasoning(choice?.message?.reasoning_details);
      const responseMode =
        content.trim().length > 0 ? 'content' : hasReasoning ? 'reasoning-only' : 'empty';

      const reasoningTrace = content.includes('<thinking>')
        ? (content.split('<thinking>')[1]?.split('</thinking>')[0]?.split(/\r?\n/) ?? [])
            .map((line) => line.trim())
            .filter(Boolean)
        : content.trim()
          ? [content]
          : [];

      return {
        content,
        reasoningTrace:
          reasoningTrace.filter(Boolean).length > 0
            ? reasoningTrace.filter(Boolean)
            : [
                responseMode === 'reasoning-only'
                  ? 'Provider returned reasoning without a final answer.'
                  : 'Provider returned no final answer.',
              ],
        confidence: 0.85,
        usage: {
          inputTokens: data.usage?.prompt_tokens || 0,
          outputTokens: data.usage?.completion_tokens || 0,
        },
        responseTimeMs: Date.now() - startTime,
        responseMode,
        finishReason: choice?.finish_reason,
      };
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        throw new Error(`OpenAI API request timed out after ${this.timeoutMs}ms`);
      }
      throw e;
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * OpenRouter-compatible providers vary between a string `reasoning` field and
 * structured `reasoning_details`. Null/empty placeholders are not evidence
 * that reasoning was actually returned; classify them as empty so callers do
 * not report a misleading reasoning-only response.
 */
function hasProviderReasoning(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return value !== null && typeof value === 'object' && Object.keys(value).length > 0;
}
