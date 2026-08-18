import { LLMProvider, LLMResponse, LLMConfig, DEFAULT_TIMEOUT_MS } from './types.js';

export class AnthropicProvider implements LLMProvider {
  name = 'anthropic';
  model: string;
  private apiKey: string;
  private deepModel: string;
  private apiUrl: string;
  private timeoutMs: number;

  constructor(config: LLMConfig) {
    this.model = config.model;
    this.deepModel = config.deepModel || config.model;
    this.apiKey = config.apiKey || '';
    this.apiUrl = config.apiUrl || 'https://api.anthropic.com/v1';
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
      throw new Error('Anthropic API key not configured');
    }

    const startTime = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.apiUrl}/messages`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.deepModel,
          max_tokens: 4000,
          temperature,
          system: systemPrompt ?? '',
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`Anthropic API error: ${response.status} ${err}`);
      }

      const data = await response.json() as Record<string, unknown>;
      const content = (data.content as Array<{ text: string } >)?.[0]?.text || '';
      const reasoningTrace = this.extractReasoningTrace(content);

      return {
        content,
        reasoningTrace,
        confidence: 0.9,
        usage: {
          inputTokens: (data.usage as Record<string, number>)?.input_tokens || 0,
          outputTokens: (data.usage as Record<string, number>)?.output_tokens || 0,
        },
        responseTimeMs: Date.now() - startTime,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private extractReasoningTrace(content: string): string[] {
    const lines = content.split('\n');
    const trace: string[] = [];
    let inTrace = false;

    for (const line of lines) {
      if (line.match(/^\d+\.\s/)) {
        trace.push(line.trim());
        inTrace = true;
      } else if (line.includes('VERDICT:') || line.includes('CONFIDENCE:') || line.includes('SUGGESTIONS:')) {
        inTrace = false;
      } else if (inTrace && line.trim()) {
        trace.push(line.trim());
      }
    }

    return trace.length > 0 ? trace : ['No explicit reasoning trace found in response'];
  }
}