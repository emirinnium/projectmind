import { LLMProvider, LLMResponse, LLMConfig, DEFAULT_TIMEOUT_MS } from './types.js';

export class OllamaProvider implements LLMProvider {
  name = 'ollama';
  model: string;
  private apiUrl: string;
  private timeoutMs: number;

  constructor(config: LLMConfig) {
    this.model = config.model;
    this.apiUrl = config.apiUrl || 'http://localhost:11434/api';
    this.timeoutMs = config.timeoutMs || DEFAULT_TIMEOUT_MS;
  }

  isAvailable(): boolean {
    return true;
  }

  async analyze(
    prompt: string,
    systemPrompt?: string,
    temperature: number = 0.3
  ): Promise<LLMResponse> {
    const startTime = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const messages: { role: string; content: string }[] = [];
      if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
      }
      messages.push({ role: 'user', content: prompt });

      const response = await fetch(`${this.apiUrl}/chat`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          temperature,
          stream: false,
          messages,
        }),
      });

      if (!response.ok) {
        throw new Error(`Ollama API error: ${response.status}`);
      }

      const data = await response.json() as Record<string, unknown>;
      const content = (data.message as Record<string, unknown>)?.content as string || '';

      const reasoningTrace = content.includes('<thinking>')
        ? content.split('<thinking>')[1]?.split('</thinking>')[0]?.split('\n') ?? [content]
        : [content];

      return {
        content,
        reasoningTrace: reasoningTrace.filter(Boolean),
        confidence: 0.8,
        responseTimeMs: Date.now() - startTime,
      };
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        throw new Error(`Ollama API request timed out after ${this.timeoutMs}ms`);
      }
      throw e;
    } finally {
      clearTimeout(timeout);
    }
  }
}