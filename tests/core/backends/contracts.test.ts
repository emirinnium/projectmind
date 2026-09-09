import { describe, expect, it } from 'vitest';
import { parseBackendDescriptor } from '../../../src/core/backends/contracts.js';

describe('optional backend contracts', () => {
  it('validates local and remote descriptors through one runtime schema', () => {
    const descriptor = parseBackendDescriptor({
      id: 'sqlite-graph',
      kind: 'graph',
      remote: false,
      credentialsRequired: false,
      capabilities: ['nodes', 'edges', 'traversal'],
    });
    expect(descriptor.kind).toBe('graph');
    expect(() => parseBackendDescriptor({ ...descriptor, kind: 'unknown' })).toThrow();
    expect(() => parseBackendDescriptor({ ...descriptor, unexpected: true })).toThrow();
  });
});
