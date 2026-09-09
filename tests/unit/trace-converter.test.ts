import { describe, expect, it } from 'vitest';
import { convertTraceContent } from '../../src/core/trace/converter.js';

describe('trace conversion', () => {
  it('converts Code-Graph-RAG JSONL edge records and stack records', () => {
    const result = convertTraceContent(
      [
        JSON.stringify({
          from_function: 'router.dispatch',
          to_function: 'handler.run',
          workload_id: 'api-smoke',
          dynamic_call_count: 3,
          static_missed: true,
        }),
        JSON.stringify({
          stack: ['main', 'router.dispatch', 'handler.run'],
          workload: 'stack-smoke',
        }),
      ].join('\n'),
      'cgr',
    );

    expect(result.events).toEqual([
      {
        fromFunctionName: 'router.dispatch',
        toFunctionName: 'handler.run',
        workloadId: 'api-smoke',
        callCount: 3,
        staticMissed: true,
      },
      {
        fromFunctionName: 'main',
        toFunctionName: 'router.dispatch',
        workloadId: 'stack-smoke',
        callCount: 1,
        staticMissed: false,
      },
      {
        fromFunctionName: 'router.dispatch',
        toFunctionName: 'handler.run',
        workloadId: 'stack-smoke',
        callCount: 1,
        staticMissed: false,
      },
    ]);
    expect(result.skippedRecords).toBe(0);
  });

  it('converts V8 cpuprofile samples into weighted parent-child edges', () => {
    const result = convertTraceContent(
      JSON.stringify({
        nodes: [
          { id: 1, callFrame: { functionName: '(root)', url: '' }, children: [2] },
          { id: 2, callFrame: { functionName: 'main', url: 'app.js' }, children: [3] },
          { id: 3, callFrame: { functionName: 'work', url: 'app.js' }, children: [] },
        ],
        samples: [3, 3, 3],
      }),
      'cpuprofile',
      'cpu-smoke',
    );

    expect(result.events).toEqual([
      {
        fromFunctionName: 'main',
        toFunctionName: 'work',
        workloadId: 'cpu-smoke',
        callCount: 3,
        staticMissed: false,
      },
    ]);
    expect(result.warnings[0]).toContain('sampled observations');
  });

  it('handles quoted CSV cells without splitting embedded commas', () => {
    const result = convertTraceContent(
      'fromFunctionName,toFunctionName,workloadId,callCount\n"router,dispatch",handler.run,"nightly,full",4\n',
      'csv',
    );

    expect(result.events).toEqual([
      {
        fromFunctionName: 'router,dispatch',
        toFunctionName: 'handler.run',
        workloadId: 'nightly,full',
        callCount: 4,
        staticMissed: false,
      },
    ]);
  });

  it('reports skipped malformed JSONL records instead of silently dropping them', () => {
    const result = convertTraceContent(
      `${JSON.stringify({ from: 'a', to: 'b' })}\n${JSON.stringify({ from: 'missing-callee' })}`,
      'cgr',
    );

    expect(result.events).toHaveLength(1);
    expect(result.skippedRecords).toBe(1);
    expect(result.warnings[0]).toContain('missing caller/callee');
  });

  it('accepts the existing JSON calls/events envelope', () => {
    const result = convertTraceContent(
      JSON.stringify({ calls: [{ fromFunctionName: 'a', toFunctionName: 'b' }] }),
      'json',
    );

    expect(result.events[0]).toMatchObject({
      fromFunctionName: 'a',
      toFunctionName: 'b',
      workloadId: 'converted',
      callCount: 1,
    });
  });
});
