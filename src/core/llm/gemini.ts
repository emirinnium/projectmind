import {
  LLMProvider,
  LLMResponse,
  LLMConfig,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_TOKENS,
} from './types.js';
import { validateApiUrl } from './url-validator.js';

interface GeminiCandidate {
  content?: {
    parts?: Array<{ text: string }>;
  };
}

interface GeminiUsageMetadata {
  promptTokenCount: number;
  candidatesTokenCount: number;
}

interface GeminiResponse {
  candidates?: Array<GeminiCandidate>;
  usageMetadata?: GeminiUsageMetadata;
}

export class GeminiProvider implements LLMProvider {
  name = 'gemini';
  model: string;
  private apiKey: string;
  private apiUrl: string;
  private timeoutMs: number;
  private maxTokens: number;

  constructor(config: LLMConfig) {
    this.model = config.model;
    this.apiKey = config.apiKey || '';
    this.apiUrl = validateApiUrl(
      config.apiUrl || 'https://generativelanguage.googleapis.com/v1beta',
      'gemini',
    );
    this.timeoutMs = config.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
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
      throw new Error('Gemini API key not configured');
    }

    const startTime = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      interface GeminiRequestBody {
        contents: Array<{ role: string; parts: Array<{ text: string }> }>;
        generationConfig: { temperature: number; maxOutputTokens: number };
        systemInstruction?: { parts: Array<{ text: string }> };
      }
      const requestBody: GeminiRequestBody = {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature, maxOutputTokens: this.maxTokens },
      };

      // Gemini API expects systemInstruction as a separate field
      if (systemPrompt) {
        requestBody.systemInstruction = { parts: [{ text: systemPrompt }] };
      }

      const response = await fetch(
        `${this.apiUrl}/models/${this.model}:generateContent?key=${this.apiKey}`,
        {
          method: 'POST',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
        },
      );

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`Gemini API error: ${response.status} ${err}`);
      }

      const data = (await response.json()) as GeminiResponse;
      const content = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

      // Extract reasoning trace (numbered steps)
      const reasoningTrace = content
        .split(/\r?\n/)
        .filter((line: string) => line.trim().match(/^\d+\.\s/))
        .map((l: string) => l.trim());

      // Extract token usage if available
      const usage = data.usageMetadata
        ? {
            inputTokens: data.usageMetadata.promptTokenCount || 0,
            outputTokens: data.usageMetadata.candidatesTokenCount || 0,
          }
        : undefined;

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
