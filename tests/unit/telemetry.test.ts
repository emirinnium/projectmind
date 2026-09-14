import { describe, expect, it, beforeEach } from 'vitest';
import {
  measureInvocation,
  resetInvocationMetrics,
  summarizeInvocationMetrics,
} from '../../src/core/telemetry/invocation.js';

describe('MCP invocation telemetry', () => {
  beforeEach(() => resetInvocationMetrics());

  it('records cold/warm latency and output token estimates without changing the value', async () => {
    await expect(
      measureInvocation('demo', { query: 'x' }, async () => ({ ok: true })),
    ).resolves.toMatchObject({ value: { ok: true }, metrics: { cold: true, ok: true } });
    await measureInvocation('demo', {}, async () => 'second');
    const summary = summarizeInvocationMetrics('demo').demo;
    expect(summary.count).toBe(2);
    expect(summary.coldCount).toBe(1);
    expect(summary.warmCount).toBe(1);
    expect(summary.avgInputBytes).toBeGreaterThan(0);
    expect(summary.avgInputTokens).toBeGreaterThan(0);
    expect(summary.p50Ms).toBeGreaterThanOrEqual(0);
    expect(summary.avgOutputTokens).toBeGreaterThan(0);
    expect(summary.errorRate).toBe(0);
  });

  it('records failures in the error rate while preserving measurable input cost', async () => {
    await expect(
      measureInvocation('failure', { query: 'x' }, async () => {
        throw new Error('expected failure');
      }),
    ).rejects.toThrow('expected failure');
    expect(summarizeInvocationMetrics('failure').failure).toMatchObject({
      count: 1,
      errors: 1,
      errorRate: 1,
      avgInputTokens: 4,
    });
  });
});
