import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readSourceRange } from '../../../src/core/retrieval/byte-range.js';

describe('byte-range retrieval', () => {
  it('returns exact bounded UTF-8 content with line coordinates', () => {
    const root = mkdtempSync(join(tmpdir(), 'projectmind-range-'));
    writeFileSync(join(root, 'unicode.ts'), 'const café = 1;\r\nconst second = 2;\r\n', 'utf8');
    const full = readSourceRange(
      'unicode.ts',
      root,
      0,
      Buffer.byteLength('const café = 1;\r\n', 'utf8'),
    );
    expect(full.content).toBe('const café = 1;\r\n');
    expect(full.lineStart).toBe(1);
    expect(full.lineEnd).toBe(2);
    expect(full.lineEnding).toBe('crlf');
    expect(full.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(full.sourceBytes).toBeGreaterThan(full.returnedBytes);
    expect(full.bytesSaved).toBeGreaterThan(0);
    expect(full.estimatedTokensSaved).toBeGreaterThan(0);
  });

  it('truncates to the requested max and provides a continuation range', () => {
    const root = mkdtempSync(join(tmpdir(), 'projectmind-range-'));
    writeFileSync(join(root, 'long.ts'), '0123456789'.repeat(10), 'utf8');
    const result = readSourceRange('long.ts', root, 2, 80, 8);
    expect(result.content).toHaveLength(8);
    expect(result.truncated).toBe(true);
    expect(result.nextRange).toEqual({ startByte: 10, endByte: 80 });
  });

  it('rejects ranges that split a multi-byte UTF-8 code point', () => {
    const root = mkdtempSync(join(tmpdir(), 'projectmind-range-'));
    writeFileSync(join(root, 'unicode.ts'), 'const value = "🚀";\n', 'utf8');
    const rocketStart = Buffer.byteLength('const value = "', 'utf8');
    expect(() => readSourceRange('unicode.ts', root, rocketStart + 1, rocketStart + 2)).toThrow(
      /UTF-8 code point/,
    );
  });
});
