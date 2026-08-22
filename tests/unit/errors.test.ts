import { describe, it, expect } from 'vitest';
import { tryCatch, tryCatchAsync, assert, require } from '../../src/utils/errors.js';

describe('Errors - tryCatch', () => {
  it('returns success result for non-throwing functions', () => {
    const result = tryCatch(() => 42);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value).toBe(42);
    }
  });

  it('returns error result for throwing functions', () => {
    const result = tryCatch(() => { throw new Error('test error'); });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toBe('test error');
    }
  });

  it('handles non-Error throws', () => {
    const result = tryCatch(() => { throw 'string error'; });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toBe('string error');
    }
  });
});

describe('Errors - tryCatchAsync', () => {
  it('returns success for resolved promises', async () => {
    const result = await tryCatchAsync(async () => 42);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value).toBe(42);
    }
  });

  it('returns error for rejected promises', async () => {
    const result = await tryCatchAsync(async () => { throw new Error('async error'); });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toBe('async error');
    }
  });
});

describe('Errors - assert', () => {
  it('does not throw for true conditions', () => {
    expect(() => assert(true, 'should not throw')).not.toThrow();
  });

  it('throws for false conditions', () => {
    expect(() => assert(false, 'should throw')).toThrow('Assertion failed: should throw');
  });
});

describe('Errors - require', () => {
  it('returns value for non-null values', () => {
    expect(require(42, 'test')).toBe(42);
    expect(require('hello', 'test')).toBe('hello');
    expect(require(0, 'test')).toBe(0);
    expect(require('', 'test')).toBe('');
    expect(require(false, 'test')).toBe(false);
  });

  it('throws for null values', () => {
    expect(() => require(null, 'test')).toThrow("Required value 'test' is null");
  });

  it('throws for undefined values', () => {
    expect(() => require(undefined, 'test')).toThrow("Required value 'test' is undefined");
  });
});
