import { LLMProvider, LLMResponse, LLMConfig, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_TOKENS } from './types.js';
import { validateApiUrl } from './url-validator.js';

interface GroqUsage {
  prompt_tokens: number;
  completion_tokens: number;
}

interface GroqResponse {
  choices?: Array<{
    message?: {
      content: string;
    };
  }>;
  usage?: GroqUsage;
}

export class GroqProvider implements LLMProvider {
  name = 'groq';
  model: string;
  private apiKey: string;
  private apiUrl: string;
  private timeoutMs: number;
  private maxTokens: number;

  constructor(config: LLMConfig) {
    this.model = config.model;
    this.apiKey = config.apiKey || '';
    this.apiUrl = validateApiUrl(config.apiUrl || 'https://api.groq.com/openai/v1', 'groq');
    this.timeoutMs = config.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
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
      throw new Error('Groq API key not configured');
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
          max_tokens: this.maxTokens,
          temperature,
          messages,
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`Groq API error: ${response.status} ${err}`);
      }

      const data = await response.json() as GroqResponse;
      const choice = data.choices?.[0];
      const content = choice?.message?.content || '';

      // Extract reasoning trace (numbered steps)
      const reasoningTrace = content
        .split(/\r?\n/)
        .filter((line: string) => line.trim().match(/^\d+\.\s/))
        .map((l: string) => l.trim());

      const usage = data.usage ? {
        inputTokens: data.usage.prompt_tokens || 0,
        outputTokens: data.usage.completion_tokens || 0,
      } : undefined;

      return {
        content,
        reasoningTrace: reasoningTrace.length > 0 ? reasoningTrace : [content.substring(0, 200)],
        confidence: 0.85,
        usage,
        responseTimeMs: Date.now() - startTime,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}