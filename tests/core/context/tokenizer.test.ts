import { describe, expect, it } from 'vitest';
import {
  createContextTokenCounter,
  countContextFileTokens,
  estimateContextTokens,
} from '@/core/context/tokenizer.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('context token counter', () => {
  it('keeps the offline heuristic deterministic and explicit', async () => {
    const counter = await createContextTokenCounter();
    expect(counter.mode).toBe('heuristic');
    expect(counter.model).toBeNull();
    expect(await counter.count('12345678')).toBe(2);
    expect(estimateContextTokens('12345678')).toBe(2);
    expect(counter.limitations.join(' ')).toContain('heuristic');
  });

  it('uses UTF-8 bytes for non-ASCII source instead of UTF-16 code units', async () => {
    const source = 'ééé';

    expect(Buffer.byteLength(source, 'utf8')).toBe(6);
    expect(estimateContextTokens(source)).toBe(2);
    const counter = await createContextTokenCounter();
    expect(await counter.count(source)).toBe(2);
  });

  it('counts through an injected tokenizer-shaped output without persisting source text', async () => {
    const root = mkdtempSync(join(tmpdir(), 'projectmind-tokenizer-'));
    const file = join(root, 'sample.ts');
    writeFileSync(file, 'const secret = "do-not-return";\n');
    const counter = {
      mode: 'transformers' as const,
      model: 'fixture-tokenizer',
      limitations: [],
      count: async (text: string) => Math.max(1, text.split(/\s+/u).filter(Boolean).length),
    };
    expect(await countContextFileTokens(file, counter)).toBe(4);
    expect(JSON.stringify(counter)).not.toContain('do-not-return');
  });
});
