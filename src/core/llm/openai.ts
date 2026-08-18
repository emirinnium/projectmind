import { LLMProvider, LLMResponse, LLMConfig, DEFAULT_TIMEOUT_MS } from './types.js';

export class OpenAIProvider implements LLMProvider {
  name = 'openai';
  model: string;
  private apiKey: string;
  private apiUrl: string;
  private timeoutMs: number;

  constructor(config: LLMConfig) {
    this.model = config.model;
    this.apiKey = config.apiKey || '';
    this.apiUrl = config.apiUrl || 'https://api.openai.com/v1';
    this.timeoutMs = config.timeoutMs || DEFAULT_TIMEOUT_MS;
  }

  isAvailable(): boolean {
    return !!this.apiKey;
  }

  async analyze(
    prompt: string,
    systemPrompt?: string,
    temperature: number = 0.3
  ): Promise<LLMResponse> {
    if (!this.isAvailable()) {
      throw new Error('OpenAI API key not configured');
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

      const response = await fetch(`${this.apiUrl}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 4000,
          temperature,
          messages,
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`OpenAI API error: ${response.status} ${err}`);
      }

      const data = await response.json() as Record<string, unknown>;
      const choice = (data.choices as Array<Record<string, unknown>>)?.[0];
      const content = (choice?.message as Record<string, unknown>)?.content as string || '';

      const reasoningTrace = content.includes('<thinking>')
        ? content.split('<thinking>')[1]?.split('</thinking>')[0]?.split('\n') ?? [content]
        : [content];

      return {
        content,
        reasoningTrace: reasoningTrace.filter(Boolean),
        confidence: 0.85,
        usage: {
          inputTokens: (data.usage as Record<string, number>)?.prompt_tokens || 0,
          outputTokens: (data.usage as Record<string, number>)?.completion_tokens || 0,
        },
        responseTimeMs: Date.now() - startTime,
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