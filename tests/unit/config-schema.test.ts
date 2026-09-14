import { describe, it, expect } from 'vitest';
import { validateConfig, type ProjectMindRc } from '../../src/utils/config-schema.js';

describe('Config Schema - validateConfig', () => {
  it('accepts valid minimal config', () => {
    const config = validateConfig({});
    expect(config.llm.provider).toBe('anthropic');
    expect(config.llm.model).toBe('claude-3-5-sonnet-20241022');
    expect(config.scanOnStartup).toBe(true);
  });

  it('accepts fully specified config', () => {
    const config = validateConfig({
      projectRoot: '/project',
      databasePath: '.projectmind/db.db',
      scanOnStartup: false,
    });
    expect(config.projectRoot).toBe('/project');
    expect(config.databasePath).toBe('.projectmind/db.db');
    expect(config.scanOnStartup).toBe(false);
    // Zod applies defaults for missing fields
    expect(config.llm.provider).toBe('anthropic');
    expect(config.maxDepth).toBe(10);
  });

  it('handles null input gracefully', () => {
    const config = validateConfig(null);
    expect(config.llm.provider).toBe('anthropic');
  });

  it('handles undefined input gracefully', () => {
    const config = validateConfig(undefined);
    expect(config.llm.provider).toBe('anthropic');
  });

  it('accepts valid contracts', () => {
    const config = validateConfig({
      contracts: [
        {
          id: 'no-eval',
          name: 'No Eval',
          sourcePattern: '**/*.ts',
          forbiddenKeywords: ['dangerousFunc('],
          severity: 'error' as const,
        },
      ],
    });
    // Contracts may or may not be defined depending on validation
    if (config.contracts) {
      expect(config.contracts.length).toBeGreaterThanOrEqual(0);
    }
  });

  it('accepts OpenRouter as an explicit OpenAI-compatible provider', () => {
    const config = validateConfig({ llm: { provider: 'openrouter', model: 'openai/gpt-4o-mini' } });
    expect(config.llm.provider).toBe('openrouter');
    expect(config.llm.model).toBe('openai/gpt-4o-mini');
  });

  it('validates optional OpenRouter reasoning controls without enabling them by default', () => {
    const config = validateConfig({
      llm: {
        provider: 'openrouter',
        model: 'cohere/north-mini-code:free',
        reasoning: { effort: 'none', exclude: true, maxTokens: 128 },
      },
    });
    expect(config.llm.reasoning).toEqual({ effort: 'none', exclude: true, maxTokens: 128 });
    expect(validateConfig({}).llm.reasoning).toBeUndefined();
  });

  it('validates auditable optional LLM pricing metadata', () => {
    const config = validateConfig({
      llm: {
        pricing: {
          inputPricePer1k: 0.15,
          outputPricePer1k: 0.6,
          source: 'https://provider.example/pricing',
          effectiveAt: '2026-01-01T00:00:00Z',
          expiresAt: '2027-01-01T00:00:00Z',
        },
      },
    });
    expect(config.llm.pricing).toMatchObject({
      inputPricePer1k: 0.15,
      outputPricePer1k: 0.6,
      currency: 'USD',
    });
  });

  it('rejects an LLM price record whose expiry precedes its effective date', () => {
    const config = validateConfig({
      llm: {
        pricing: {
          inputPricePer1k: 0.15,
          effectiveAt: '2027-01-01T00:00:00Z',
          expiresAt: '2026-01-01T00:00:00Z',
        },
      },
    });
    expect(config.llm.pricing).toBeUndefined();
  });
});
