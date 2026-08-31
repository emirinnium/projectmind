import { LLMProvider, LLMResponse, LLMConfig, DEFAULT_TIMEOUT_MS } from './types.js';
import { validateApiUrl } from './url-validator.js';

const DEFAULT_OLLAMA_URL = 'http://localhost:11434/api';

export class OllamaProvider implements LLMProvider {
  name = 'ollama';
  model: string;
  private apiUrl: string;
  private timeoutMs: number;

  constructor(config: LLMConfig) {
    this.model = config.model;
    // Ollama is self-hosted, so it uses HTTP and localhost/private IPs
    this.apiUrl = validateApiUrl(config.apiUrl || DEFAULT_OLLAMA_URL, 'ollama');
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

      interface OllamaResponse { message?: { content?: string } }
      const data = await response.json() as OllamaResponse;
      const content = data.message?.content || '';

      const reasoningTrace = content.includes('<thinking>')
        ? content.split('<thinking>')[1]?.split('</thinking>')[0]?.split(/\r?\n/) ?? [content]
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