import { describe, expect, it } from 'vitest';
import {
  renderTokenizerBenchmarkMarkdown,
  runTokenizerBenchmark,
} from '../../scripts/benchmark/tokenizer.mjs';

describe('internal production tokenizer benchmark', () => {
  it('measures the deterministic production heuristic without returning fixture source', async () => {
    const result = await runTokenizerBenchmark({ mode: 'heuristic', repeats: 2 });
    expect(result.benchmark).toBe('projectmind-context-tokenizer');
    expect(result.mode).toBe('heuristic');
    expect(result.cases.length).toBeGreaterThan(1);
    expect(result.aggregate.providerTokens).toBe(result.aggregate.estimatedTokens);
    expect(result.inputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain('kullanıcıEtiketi');
    expect(renderTokenizerBenchmarkMarkdown(result)).toContain('Provider tokens');
  });

  it('keeps repeated fixture measurements stable and input-hash deterministic', async () => {
    const cases = [{ id: 'fixture', text: 'export const value = 42;\n' }];
    const first = await runTokenizerBenchmark({ mode: 'heuristic', repeats: 3, cases });
    const second = await runTokenizerBenchmark({ mode: 'heuristic', repeats: 3, cases });
    expect(first.inputHash).toBe(second.inputHash);
    expect(first.cases[0]?.stable).toBe(true);
    expect(first.cases[0]?.providerTokens).toBeGreaterThan(0);
  });

  it('rejects unbounded repeat counts', async () => {
    await expect(runTokenizerBenchmark({ repeats: 21 })).rejects.toThrow('between 1 and 20');
  });

  it('rejects an unknown tokenizer mode instead of silently selecting a provider', async () => {
    await expect(runTokenizerBenchmark({ mode: 'unknown' })).rejects.toThrow(
      'must be heuristic or transformers',
    );
  });
});
