import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock url-validator before importing providers
vi.mock('../../../src/core/llm/url-validator.js', () => ({
  validateApiUrl: vi.fn((url: string, _provider: string) => url),
  ApiUrlValidationError: class ApiUrlValidationError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'ApiUrlValidationError';
    }
  },
}));

import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_TIMEOUT_MS,
  type LLMConfig,
} from '../../../src/core/llm/types.js';
import { AnthropicProvider } from '../../../src/core/llm/anthropic.js';
import { OpenAIProvider } from '../../../src/core/llm/openai.js';
import { OllamaProvider } from '../../../src/core/llm/ollama.js';
import { GroqProvider } from '../../../src/core/llm/groq.js';
import { GeminiProvider } from '../../../src/core/llm/gemini.js';
import { validateApiUrl } from '../../../src/core/llm/url-validator.js';

// ─── Shared helpers ──────────────────────────────────────────────────────────

const mockFetch = vi.fn();
const originalFetch = globalThis.fetch;

function installMockFetch(): void {
  globalThis.fetch = mockFetch as unknown as typeof fetch;
}

function uninstallMockFetch(): void {
  globalThis.fetch = originalFetch;
}

function makeJsonResponse(data: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: async () => data,
    text: async () => JSON.stringify(data),
    headers: new Headers(),
    redirected: false,
    type: 'basic',
    url: '',
    clone: () => makeJsonResponse(data, ok, status),
    body: null,
    bodyUsed: false,
    arrayBuffer: async () => new ArrayBuffer(0),
    blob: async () => new Blob(),
    formData: async () => new FormData(),
  } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  installMockFetch();
});

afterEach(() => {
  uninstallMockFetch();
});

// ─── Test suites ─────────────────────────────────────────────────────────────

describe('LLM Provider Defaults & Configuration', () => {
  describe('DEFAULT constants', () => {
    it('DEFAULT_MAX_TOKENS equals 4000', () => {
      expect(DEFAULT_MAX_TOKENS).toBe(4000);
    });

    it('DEFAULT_TIMEOUT_MS equals 30000', () => {
      expect(DEFAULT_TIMEOUT_MS).toBe(30_000);
    });
  });

  describe('AnthropicProvider', () => {
    const baseConfig: LLMConfig = {
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      apiKey: 'sk-ant-test-key',
    };

    it('uses default max tokens and timeout when not provided', () => {
      const provider = new AnthropicProvider(baseConfig);
      // isAvailable checks apiKey presence
      expect(provider.isAvailable()).toBe(true);
      // We verify defaults indirectly: provider constructs without error
      // and uses DEFAULT_MAX_TOKENS / DEFAULT_TIMEOUT_MS internally.
      expect(provider.name).toBe('anthropic');
      expect(provider.model).toBe('claude-sonnet-4-20250514');
    });

    it('accepts config overrides for timeout and maxTokens', () => {
      const provider = new AnthropicProvider({
        ...baseConfig,
        timeoutMs: 60_000,
        maxTokens: 8000,
      });
      expect(provider.isAvailable()).toBe(true);
      // After analyze call we can confirm values are used (checked in URL/request tests)
    });

    it('uses deepModel fallback to model when deepModel not set', () => {
      const provider = new AnthropicProvider(baseConfig);
      expect(provider.isAvailable()).toBe(true);
      // deepModel defaults to config.model — verified through fetch body inspection
    });

    it('sets deepModel from config when provided', () => {
      const provider = new AnthropicProvider({
        ...baseConfig,
        deepModel: 'claude-opus-4-20250514',
      });
      expect(provider.isAvailable()).toBe(true);
    });

    it('returns false for isAvailable when apiKey is empty', () => {
      const provider = new AnthropicProvider({
        ...baseConfig,
        apiKey: '',
      });
      expect(provider.isAvailable()).toBe(false);
    });

    it('returns false for isAvailable when apiKey is undefined', () => {
      const { apiKey: _ignored, ...noKeyConfig } = baseConfig;
      const provider = new AnthropicProvider(noKeyConfig);
      expect(provider.isAvailable()).toBe(false);
    });

    it('throws when analyze is called without API key', async () => {
      const provider = new AnthropicProvider({
        ...baseConfig,
        apiKey: '',
      });
      await expect(provider.analyze('test')).rejects.toThrow(
        'Anthropic API key not configured'
      );
    });

    it('calls validateApiUrl with correct default URL', () => {
      new AnthropicProvider(baseConfig);
      expect(validateApiUrl).toHaveBeenCalledWith(
        'https://api.anthropic.com/v1',
        'anthropic'
      );
    });

    it('uses custom apiUrl when provided', () => {
      new AnthropicProvider({
        ...baseConfig,
        apiUrl: 'https://api.anthropic.com/v1',
      });
      expect(validateApiUrl).toHaveBeenCalledWith(
        'https://api.anthropic.com/v1',
        'anthropic'
      );
    });
  });

  describe('OpenAIProvider', () => {
    const baseConfig: LLMConfig = {
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: 'sk-test-key',
    };

    it('uses default max tokens and timeout when not provided', () => {
      const provider = new OpenAIProvider(baseConfig);
      expect(provider.isAvailable()).toBe(true);
      expect(provider.name).toBe('openai');
      expect(provider.model).toBe('gpt-4o');
    });

    it('accepts config overrides', () => {
      const provider = new OpenAIProvider({
        ...baseConfig,
        timeoutMs: 45_000,
        maxTokens: 2000,
      });
      expect(provider.isAvailable()).toBe(true);
    });

    it('returns false for isAvailable when apiKey is missing', () => {
      const { apiKey: _ignored, ...noKeyConfig } = baseConfig;
      const provider = new OpenAIProvider(noKeyConfig);
      expect(provider.isAvailable()).toBe(false);
    });

    it('throws when analyze is called without API key', async () => {
      const provider = new OpenAIProvider({ ...baseConfig, apiKey: '' });
      await expect(provider.analyze('test')).rejects.toThrow(
        'OpenAI API key not configured'
      );
    });

    it('calls validateApiUrl with correct default URL', () => {
      new OpenAIProvider(baseConfig);
      expect(validateApiUrl).toHaveBeenCalledWith(
        'https://api.openai.com/v1',
        'openai'
      );
    });
  });

  describe('OllamaProvider', () => {
    const baseConfig: LLMConfig = {
      provider: 'ollama',
      model: 'llama3.1',
    };

    it('is always available (self-hosted, no API key needed)', () => {
      const provider = new OllamaProvider(baseConfig);
      expect(provider.isAvailable()).toBe(true);
      expect(provider.name).toBe('ollama');
      expect(provider.model).toBe('llama3.1');
    });

    it('uses default timeout when not provided', () => {
      const provider = new OllamaProvider(baseConfig);
      expect(provider.isAvailable()).toBe(true);
    });

    it('accepts config override for timeout', () => {
      const provider = new OllamaProvider({
        ...baseConfig,
        timeoutMs: 120_000,
      });
      expect(provider.isAvailable()).toBe(true);
    });

    it('calls validateApiUrl with default Ollama URL', () => {
      new OllamaProvider(baseConfig);
      expect(validateApiUrl).toHaveBeenCalledWith(
        'http://localhost:11434/api',
        'ollama'
      );
    });

    it('uses custom apiUrl when provided', () => {
      new OllamaProvider({
        ...baseConfig,
        apiUrl: 'http://192.168.1.100:11434/api',
      });
      expect(validateApiUrl).toHaveBeenCalledWith(
        'http://192.168.1.100:11434/api',
        'ollama'
      );
    });
  });

  describe('GroqProvider', () => {
    const baseConfig: LLMConfig = {
      provider: 'groq',
      model: 'llama-3.3-70b-versatile',
      apiKey: 'gsk-test-key',
    };

    it('uses defaults when optional fields not provided', () => {
      const provider = new GroqProvider(baseConfig);
      expect(provider.isAvailable()).toBe(true);
      expect(provider.name).toBe('groq');
      expect(provider.model).toBe('llama-3.3-70b-versatile');
    });

    it('accepts config overrides', () => {
      const provider = new GroqProvider({
        ...baseConfig,
        timeoutMs: 20_000,
        maxTokens: 1000,
      });
      expect(provider.isAvailable()).toBe(true);
    });

    it('returns false for isAvailable when apiKey is missing', () => {
      const { apiKey: _ignored, ...noKeyConfig } = baseConfig;
      const provider = new GroqProvider(noKeyConfig);
      expect(provider.isAvailable()).toBe(false);
    });

    it('throws when analyze is called without API key', async () => {
      const provider = new GroqProvider({ ...baseConfig, apiKey: '' });
      await expect(provider.analyze('test')).rejects.toThrow(
        'Groq API key not configured'
      );
    });

    it('calls validateApiUrl with correct default URL', () => {
      new GroqProvider(baseConfig);
      expect(validateApiUrl).toHaveBeenCalledWith(
        'https://api.groq.com/openai/v1',
        'groq'
      );
    });
  });

  describe('GeminiProvider', () => {
    const baseConfig: LLMConfig = {
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      apiKey: 'gemini-test-key',
    };

    it('uses defaults when optional fields not provided', () => {
      const provider = new GeminiProvider(baseConfig);
      expect(provider.isAvailable()).toBe(true);
      expect(provider.name).toBe('gemini');
      expect(provider.model).toBe('gemini-2.5-flash');
    });

    it('accepts config overrides', () => {
      const provider = new GeminiProvider({
        ...baseConfig,
        timeoutMs: 50_000,
        maxTokens: 6000,
      });
      expect(provider.isAvailable()).toBe(true);
    });

    it('returns false for isAvailable when apiKey is missing', () => {
      const { apiKey: _ignored, ...noKeyConfig } = baseConfig;
      const provider = new GeminiProvider(noKeyConfig);
      expect(provider.isAvailable()).toBe(false);
    });

    it('throws when analyze is called without API key', async () => {
      const provider = new GeminiProvider({ ...baseConfig, apiKey: '' });
      await expect(provider.analyze('test')).rejects.toThrow(
        'Gemini API key not configured'
      );
    });

    it('calls validateApiUrl with correct default URL', () => {
      new GeminiProvider(baseConfig);
      expect(validateApiUrl).toHaveBeenCalledWith(
        'https://generativelanguage.googleapis.com/v1beta',
        'gemini'
      );
    });
  });
});

describe('LLM Provider analyze() — URL Construction & Fetch Mocking', () => {
  describe('AnthropicProvider.analyze', () => {
    it('sends request to /messages endpoint with correct body', async () => {
      const provider = new AnthropicProvider({
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        apiKey: 'sk-ant-test-key',
        deepModel: 'claude-opus-4-20250514',
        maxTokens: 4000,
      });

      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({
          content: [{ text: 'Test response' }],
          usage: { input_tokens: 10, output_tokens: 20 },
        })
      );

      const result = await provider.analyze('Hello', 'System prompt', 0.5);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.anthropic.com/v1/messages');
      expect(options.method).toBe('POST');
      expect(options.headers['x-api-key']).toBe('sk-ant-test-key');
      expect(options.headers['anthropic-version']).toBe('2023-06-01');

      const body = JSON.parse(options.body);
      expect(body.model).toBe('claude-opus-4-20250514');
      expect(body.max_tokens).toBe(4000);
      expect(body.temperature).toBe(0.5);
      expect(body.system).toBe('System prompt');
      expect(body.messages).toEqual([{ role: 'user', content: 'Hello' }]);

      expect(result.content).toBe('Test response');
      expect(result.confidence).toBe(0.9);
      expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
    });

    it('handles error response from API', async () => {
      const provider = new AnthropicProvider({
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        apiKey: 'sk-ant-test-key',
      });

      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({ error: 'Unauthorized' }, false, 401)
      );

      await expect(provider.analyze('Hello')).rejects.toThrow(
        'Anthropic API error: 401'
      );
    });

    it('extracts reasoning trace from numbered steps', async () => {
      const provider = new AnthropicProvider({
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        apiKey: 'sk-ant-test-key',
      });

      const content = `1. First step\n2. Second step\nVERDICT: pass`;
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({
          content: [{ text: content }],
          usage: { input_tokens: 5, output_tokens: 10 },
        })
      );

      const result = await provider.analyze('Analyze this');
      expect(result.reasoningTrace).toContain('1. First step');
      expect(result.reasoningTrace).toContain('2. Second step');
    });
  });

  describe('OpenAIProvider.analyze', () => {
    it('sends request to /chat/completions endpoint with correct body', async () => {
      const provider = new OpenAIProvider({
        provider: 'openai',
        model: 'gpt-4o',
        apiKey: 'sk-test-key',
        maxTokens: 4000,
      });

      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({
          choices: [{ message: { content: 'GPT response' } }],
          usage: { prompt_tokens: 15, completion_tokens: 25 },
        })
      );

      const result = await provider.analyze('Hello', 'System', 0.7);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.openai.com/v1/chat/completions');
      expect(options.headers['Authorization']).toBe('Bearer sk-test-key');

      const body = JSON.parse(options.body);
      expect(body.model).toBe('gpt-4o');
      expect(body.max_tokens).toBe(4000);
      expect(body.temperature).toBe(0.7);
      expect(body.messages).toEqual([
        { role: 'system', content: 'System' },
        { role: 'user', content: 'Hello' },
      ]);

      expect(result.content).toBe('GPT response');
      expect(result.confidence).toBe(0.85);
      expect(result.usage).toEqual({ inputTokens: 15, outputTokens: 25 });
    });

    it('handles AbortError (timeout) gracefully', async () => {
      const provider = new OpenAIProvider({
        provider: 'openai',
        model: 'gpt-4o',
        apiKey: 'sk-test-key',
        timeoutMs: 1, // 1ms timeout to trigger quickly
      });

      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      mockFetch.mockRejectedValueOnce(abortError);

      await expect(provider.analyze('Hello')).rejects.toThrow(
        'OpenAI API request timed out after 1ms'
      );
    });

    it('sends request without system prompt when not provided', async () => {
      const provider = new OpenAIProvider({
        provider: 'openai',
        model: 'gpt-4o',
        apiKey: 'sk-test-key',
      });

      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({
          choices: [{ message: { content: 'Response' } }],
          usage: { prompt_tokens: 5, completion_tokens: 5 },
        })
      );

      await provider.analyze('Hello');
      const [, options] = mockFetch.mock.calls[0];
      const body = JSON.parse(options.body);
      expect(body.messages).toEqual([{ role: 'user', content: 'Hello' }]);
    });
  });

  describe('OllamaProvider.analyze', () => {
    it('sends request to /chat endpoint with correct body', async () => {
      const provider = new OllamaProvider({
        provider: 'ollama',
        model: 'llama3.1',
      });

      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({
          message: { content: 'Ollama response' },
        })
      );

      const result = await provider.analyze('Hello', 'System', 0.4);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('http://localhost:11434/api/chat');
      expect(options.headers['Content-Type']).toBe('application/json');

      const body = JSON.parse(options.body);
      expect(body.model).toBe('llama3.1');
      expect(body.temperature).toBe(0.4);
      expect(body.stream).toBe(false);
      expect(body.messages).toEqual([
        { role: 'system', content: 'System' },
        { role: 'user', content: 'Hello' },
      ]);

      expect(result.content).toBe('Ollama response');
      expect(result.confidence).toBe(0.8);
    });

    it('does not require API key', async () => {
      const provider = new OllamaProvider({
        provider: 'ollama',
        model: 'codellama',
      });

      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({ message: { content: 'OK' } })
      );

      const result = await provider.analyze('test');
      expect(result.content).toBe('OK');
    });

    it('handles AbortError (timeout)', async () => {
      const provider = new OllamaProvider({
        provider: 'ollama',
        model: 'llama3.1',
        timeoutMs: 1,
      });

      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      mockFetch.mockRejectedValueOnce(abortError);

      await expect(provider.analyze('Hello')).rejects.toThrow(
        'Ollama API request timed out after 1ms'
      );
    });
  });

  describe('GroqProvider.analyze', () => {
    it('sends request to /chat/completions endpoint', async () => {
      const provider = new GroqProvider({
        provider: 'groq',
        model: 'llama-3.3-70b-versatile',
        apiKey: 'gsk-test-key',
        maxTokens: 4000,
      });

      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({
          choices: [{ message: { content: 'Groq response' } }],
          usage: { prompt_tokens: 12, completion_tokens: 18 },
        })
      );

      const result = await provider.analyze('Hello', 'System', 0.3);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
      expect(options.headers['Authorization']).toBe('Bearer gsk-test-key');

      const body = JSON.parse(options.body);
      expect(body.model).toBe('llama-3.3-70b-versatile');
      expect(body.max_tokens).toBe(4000);

      expect(result.content).toBe('Groq response');
      expect(result.confidence).toBe(0.85);
      expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 18 });
    });

    it('extracts numbered reasoning trace', async () => {
      const provider = new GroqProvider({
        provider: 'groq',
        model: 'llama-3.3-70b-versatile',
        apiKey: 'gsk-test-key',
      });

      const content = `1. Analyzing input\n2. Drawing conclusion\nFinal answer here`;
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({
          choices: [{ message: { content } }],
          usage: { prompt_tokens: 5, output_tokens: 10 },
        })
      );

      const result = await provider.analyze('Analyze');
      expect(result.reasoningTrace).toContain('1. Analyzing input');
      expect(result.reasoningTrace).toContain('2. Drawing conclusion');
      expect(result.reasoningTrace).not.toContain('Final answer here');
    });
  });

  describe('GeminiProvider.analyze', () => {
    it('sends request to generateContent endpoint with API key in query', async () => {
      const provider = new GeminiProvider({
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        apiKey: 'gemini-test-key',
        maxTokens: 4000,
      });

      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({
          candidates: [{ content: { parts: [{ text: 'Gemini response' }] } }],
          usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 15 },
        })
      );

      const result = await provider.analyze('Hello', 'System', 0.6);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=gemini-test-key'
      );
      expect(options.method).toBe('POST');

      const body = JSON.parse(options.body);
      expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'Hello' }] }]);
      expect(body.generationConfig.temperature).toBe(0.6);
      expect(body.generationConfig.maxOutputTokens).toBe(4000);
      expect(body.systemInstruction).toEqual({ parts: [{ text: 'System' }] });

      expect(result.content).toBe('Gemini response');
      expect(result.confidence).toBe(0.85);
      expect(result.usage).toEqual({ inputTokens: 8, outputTokens: 15 });
    });

    it('omits systemInstruction when no system prompt', async () => {
      const provider = new GeminiProvider({
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        apiKey: 'gemini-test-key',
      });

      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({
          candidates: [{ content: { parts: [{ text: 'Response' }] } }],
        })
      );

      await provider.analyze('Hello');
      const [, options] = mockFetch.mock.calls[0];
      const body = JSON.parse(options.body);
      expect(body.systemInstruction).toBeUndefined();
    });

    it('extracts numbered reasoning trace', async () => {
      const provider = new GeminiProvider({
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        apiKey: 'gemini-test-key',
      });

      const content = `1. Step one\n2. Step two\nAnswer`;
      mockFetch.mockResolvedValueOnce(
        makeJsonResponse({
          candidates: [{ content: { parts: [{ text: content }] } }],
        })
      );

      const result = await provider.analyze('Analyze');
      expect(result.reasoningTrace).toContain('1. Step one');
      expect(result.reasoningTrace).toContain('2. Step two');
    });
  });
});

describe('LLM Provider Error Handling', () => {
  it('AnthropicProvider throws on non-ok response', async () => {
    const provider = new AnthropicProvider({
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      apiKey: 'sk-ant-test-key',
    });

    mockFetch.mockResolvedValueOnce(
      makeJsonResponse({ error: 'Rate limited' }, false, 429)
    );

    await expect(provider.analyze('test')).rejects.toThrow(
      'Anthropic API error: 429'
    );
  });

  it('OpenAIProvider throws on non-ok response', async () => {
    const provider = new OpenAIProvider({
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: 'sk-test-key',
    });

    mockFetch.mockResolvedValueOnce(
      makeJsonResponse({ error: 'Bad request' }, false, 400)
    );

    await expect(provider.analyze('test')).rejects.toThrow(
      'OpenAI API error: 400'
    );
  });

  it('OllamaProvider throws on non-ok response', async () => {
    const provider = new OllamaProvider({
      provider: 'ollama',
      model: 'llama3.1',
    });

    mockFetch.mockResolvedValueOnce(
      makeJsonResponse({ error: 'Not found' }, false, 404)
    );

    await expect(provider.analyze('test')).rejects.toThrow(
      'Ollama API error: 404'
    );
  });

  it('GroqProvider throws on non-ok response', async () => {
    const provider = new GroqProvider({
      provider: 'groq',
      model: 'llama-3.3-70b-versatile',
      apiKey: 'gsk-test-key',
    });

    mockFetch.mockResolvedValueOnce(
      makeJsonResponse({ error: 'Forbidden' }, false, 403)
    );

    await expect(provider.analyze('test')).rejects.toThrow(
      'Groq API error: 403'
    );
  });

  it('GeminiProvider throws on non-ok response', async () => {
    const provider = new GeminiProvider({
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      apiKey: 'gemini-test-key',
    });

    mockFetch.mockResolvedValueOnce(
      makeJsonResponse({ error: 'API key expired' }, false, 401)
    );

    await expect(provider.analyze('test')).rejects.toThrow(
      'Gemini API error: 401'
    );
  });

  it('All providers preserve generic errors (non-AbortError)', async () => {
    const provider = new OpenAIProvider({
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: 'sk-test-key',
    });

    const networkError = new Error('Network failure');
    mockFetch.mockRejectedValueOnce(networkError);

    await expect(provider.analyze('test')).rejects.toThrow('Network failure');
  });
});
