import { describe, expect, it } from 'vitest';
import { ApiUrlValidationError, validateApiUrl } from '../../../src/core/llm/url-validator.js';

describe('OpenRouter endpoint policy', () => {
  it('allows only the official HTTPS host', () => {
    expect(validateApiUrl('https://openrouter.ai/api/v1', 'openrouter')).toBe(
      'https://openrouter.ai/api/v1',
    );
  });

  it('rejects arbitrary OpenRouter endpoints', () => {
    expect(() => validateApiUrl('https://example.test/v1', 'openrouter')).toThrow(
      ApiUrlValidationError,
    );
  });

  it('accepts IPv6 loopback for the local Ollama provider', () => {
    expect(validateApiUrl('http://[::1]:11434/api', 'ollama')).toBe(
      'http://[::1]:11434/api',
    );
  });
});
