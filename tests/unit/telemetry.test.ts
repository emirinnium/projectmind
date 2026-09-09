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
    expect(summary.p50Ms).toBeGreaterThanOrEqual(0);
    expect(summary.avgOutputTokens).toBeGreaterThan(0);
  });
});
