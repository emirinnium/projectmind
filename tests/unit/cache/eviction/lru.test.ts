import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CacheEviction } from '../../../../src/core/cache/eviction/lru.js';
import type { CacheOptions } from '../../../../src/core/cache/types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeOptions(overrides: Partial<CacheOptions<string, string>> = {}): CacheOptions<string, string> {
  return {
    maxSize: 5,
    ttlMs: 60_000,
    ...overrides,
  };
}

// ─── Test suites ─────────────────────────────────────────────────────────────

describe('CacheEviction — LRU Eviction', () => {
  it('evicts least recently used entry when capacity is exceeded', () => {
    const evicted: string[] = [];
    const eviction = new CacheEviction<string, string>(
      makeOptions({
        maxSize: 3,
        onEvict: (key, _value) => evicted.push(key),
      })
    );

    eviction.set('a', '1');
    eviction.set('b', '2');
    eviction.set('c', '3');
    eviction.set('d', '4'); // should evict 'a'

    expect(eviction.has('a')).toBe(false);
    expect(eviction.has('b')).toBe(true);
    expect(eviction.has('c')).toBe(true);
    expect(eviction.has('d')).toBe(true);
    expect(evicted).toEqual(['a']);
  });

  it('does not evict when size is below maxSize', () => {
    const evicted: string[] = [];
    const eviction = new CacheEviction<string, string>(
      makeOptions({
        maxSize: 5,
        onEvict: (key, _value) => evicted.push(key),
      })
    );

    eviction.set('a', '1');
    eviction.set('b', '2');
    eviction.set('c', '3');

    expect(eviction.getStats().size).toBe(3);
    expect(evicted).toEqual([]);
  });

  it('evicts multiple entries when many new items are added', () => {
    const evicted: string[] = [];
    const eviction = new CacheEviction<string, string>(
      makeOptions({
        maxSize: 2,
        onEvict: (key, _value) => evicted.push(key),
      })
    );

    eviction.set('a', '1');
    eviction.set('b', '2');
    eviction.set('c', '3'); // evict 'a'
    eviction.set('d', '4'); // evict 'b'

    expect(eviction.has('a')).toBe(false);
    expect(eviction.has('b')).toBe(false);
    expect(eviction.has('c')).toBe(true);
    expect(eviction.has('d')).toBe(true);
    expect(evicted).toEqual(['a', 'b']);
  });

  it('respects maxSize of 1', () => {
    const evicted: string[] = [];
    const eviction = new CacheEviction<string, string>(
      makeOptions({
        maxSize: 1,
        onEvict: (key, _value) => evicted.push(key),
      })
    );

    eviction.set('a', '1');
    eviction.set('b', '2'); // evict 'a'
    eviction.set('c', '3'); // evict 'b'

    expect(eviction.has('a')).toBe(false);
    expect(eviction.has('b')).toBe(false);
    expect(eviction.has('c')).toBe(true);
    expect(evicted).toEqual(['a', 'b']);
  });

  it('invokes onEvict callback with correct key and value', () => {
    const evicted: Array<{ key: string; value: string }> = [];
    const eviction = new CacheEviction<string, string>(
      makeOptions({
        maxSize: 2,
        onEvict: (key, value) => evicted.push({ key, value }),
      })
    );

    eviction.set('a', 'val-a');
    eviction.set('b', 'val-b');
    eviction.set('c', 'val-c'); // evict 'a'

    expect(evicted).toEqual([{ key: 'a', value: 'val-a' }]);
  });
});

describe('CacheEviction — MRU Promotion on Access', () => {
  it('promotes accessed entry to most-recently-used position', () => {
    const evicted: string[] = [];
    const eviction = new CacheEviction<string, string>(
      makeOptions({
        maxSize: 3,
        onEvict: (key, _value) => evicted.push(key),
      })
    );

    eviction.set('a', '1');
    eviction.set('b', '2');
    eviction.set('c', '3');

    // Access 'a' to promote it to MRU
    eviction.get('a');

    // Now adding 'd' should evict 'b' (the LRU)
    eviction.set('d', '4');

    expect(eviction.has('a')).toBe(true);
    expect(eviction.has('b')).toBe(false);
    expect(eviction.has('c')).toBe(true);
    expect(eviction.has('d')).toBe(true);
    expect(evicted).toEqual(['b']);
  });

  it('updates lastAccessed timestamp on get', () => {
    vi.useFakeTimers();

    const eviction = new CacheEviction<string, string>(
      makeOptions({ maxSize: 10, ttlMs: 60_000 })
    );

    eviction.set('a', '1');
    const entryBefore = eviction.getMap().get('a');
    const lastAccessedBefore = entryBefore!.lastAccessed;

    vi.advanceTimersByTime(1000);
    eviction.get('a');

    const entryAfter = eviction.getMap().get('a');
    expect(entryAfter!.lastAccessed).toBeGreaterThan(lastAccessedBefore);

    vi.useRealTimers();
  });

  it('increments accessCount on get', () => {
    const eviction = new CacheEviction<string, string>(
      makeOptions({ maxSize: 10, ttlMs: 60_000 })
    );

    eviction.set('a', '1');
    eviction.get('a');
    eviction.get('a');
    eviction.get('a');

    const entry = eviction.getMap().get('a');
    expect(entry!.accessCount).toBe(3);
  });

  it('re-inserts entry at end of Map on access (LRU order)', () => {
    const eviction = new CacheEviction<string, string>(
      makeOptions({ maxSize: 5, ttlMs: 60_000 })
    );

    eviction.set('a', '1');
    eviction.set('b', '2');
    eviction.set('c', '3');

    // Access 'a' to move it to end
    eviction.get('a');

    const keys = eviction.getKeys();
    expect(keys).toEqual(['b', 'c', 'a']);
  });
});

describe('CacheEviction — TTL Expiration', () => {
  it('returns undefined for expired entries on get', () => {
    vi.useFakeTimers();

    const eviction = new CacheEviction<string, string>(
      makeOptions({ maxSize: 10, ttlMs: 100 })
    );

    eviction.set('key', 'value');
    expect(eviction.get('key')).toBe('value');

    vi.advanceTimersByTime(150);
    expect(eviction.get('key')).toBe(undefined);

    vi.useRealTimers();
  });

  it('has() returns false for expired entries', () => {
    vi.useFakeTimers();

    const eviction = new CacheEviction<string, string>(
      makeOptions({ maxSize: 10, ttlMs: 100 })
    );

    eviction.set('key', 'value');
    expect(eviction.has('key')).toBe(true);

    vi.advanceTimersByTime(150);
    expect(eviction.has('key')).toBe(false);

    vi.useRealTimers();
  });

  it('returns value before TTL expires', () => {
    vi.useFakeTimers();

    const eviction = new CacheEviction<string, string>(
      makeOptions({ maxSize: 10, ttlMs: 1000 })
    );

    eviction.set('key', 'value');
    vi.advanceTimersByTime(500);

    expect(eviction.get('key')).toBe('value');

    vi.useRealTimers();
  });

  it('removes expired entry from map on get', () => {
    vi.useFakeTimers();

    const eviction = new CacheEviction<string, string>(
      makeOptions({ maxSize: 10, ttlMs: 100 })
    );

    eviction.set('key', 'value');
    vi.advanceTimersByTime(150);

    eviction.get('key');
    expect(eviction.getStats().size).toBe(0);

    vi.useRealTimers();
  });

  it('removes expired entry from map on has', () => {
    vi.useFakeTimers();

    const eviction = new CacheEviction<string, string>(
      makeOptions({ maxSize: 10, ttlMs: 100 })
    );

    eviction.set('key', 'value');
    vi.advanceTimersByTime(150);

    eviction.has('key');
    expect(eviction.getStats().size).toBe(0);

    vi.useRealTimers();
  });
});

describe('CacheEviction — Delete and Clear Operations', () => {
  it('delete removes entry and returns true', () => {
    const eviction = new CacheEviction<string, string>(makeOptions());

    eviction.set('a', '1');
    expect(eviction.delete('a')).toBe(true);
    expect(eviction.has('a')).toBe(false);
  });

  it('delete returns false for non-existent key', () => {
    const eviction = new CacheEviction<string, string>(makeOptions());
    expect(eviction.delete('nonexistent')).toBe(false);
  });

  it('clear removes all entries', () => {
    const eviction = new CacheEviction<string, string>(makeOptions());

    eviction.set('a', '1');
    eviction.set('b', '2');
    eviction.set('c', '3');
    eviction.clear();

    expect(eviction.getStats().size).toBe(0);
    expect(eviction.has('a')).toBe(false);
    expect(eviction.has('b')).toBe(false);
    expect(eviction.has('c')).toBe(false);
  });

  it('clear on empty cache does not throw', () => {
    const eviction = new CacheEviction<string, string>(makeOptions());
    expect(() => eviction.clear()).not.toThrow();
  });
});

describe('CacheEviction — Size Tracking', () => {
  it('getStats reports correct size and maxSize', () => {
    const eviction = new CacheEviction<string, string>(
      makeOptions({ maxSize: 10 })
    );

    eviction.set('a', '1');
    eviction.set('b', '2');

    const stats = eviction.getStats();
    expect(stats.size).toBe(2);
    expect(stats.maxSize).toBe(10);
  });

  it('size increases with each set', () => {
    const eviction = new CacheEviction<string, string>(
      makeOptions({ maxSize: 10 })
    );

    expect(eviction.getStats().size).toBe(0);
    eviction.set('a', '1');
    expect(eviction.getStats().size).toBe(1);
    eviction.set('b', '2');
    expect(eviction.getStats().size).toBe(2);
  });

  it('size decreases after eviction', () => {
    const eviction = new CacheEviction<string, string>(
      makeOptions({ maxSize: 2 })
    );

    eviction.set('a', '1');
    eviction.set('b', '2');
    expect(eviction.getStats().size).toBe(2);

    eviction.set('c', '3'); // evicts 'a'
    expect(eviction.getStats().size).toBe(2);
  });

  it('estimateMemoryUsage returns positive value', () => {
    const eviction = new CacheEviction<string, string>(
      makeOptions({ maxSize: 10 })
    );

    eviction.set('key', 'some value');
    const usage = eviction.estimateMemoryUsage();
    expect(usage).toBeGreaterThan(0);
  });

  it('estimateMemoryUsage handles serialization errors gracefully', () => {
    const eviction = new CacheEviction<string, string>(
      makeOptions({
        maxSize: 10,
        serialize: () => { throw new Error('serialize error'); },
      })
    );

    eviction.set('key', 'value');
    // Should not throw, uses fallback estimate for value (100) + key serialization succeeds
    const usage = eviction.estimateMemoryUsage();
    // JSON.stringify('key') = 5 chars ("key"), plus 100 fallback for value serialization error
    expect(usage).toBe(105);
  });

  it('getKeys returns all keys', () => {
    const eviction = new CacheEviction<string, string>(makeOptions());

    eviction.set('a', '1');
    eviction.set('b', '2');

    const keys = eviction.getKeys();
    expect(keys).toContain('a');
    expect(keys).toContain('b');
    expect(keys).toHaveLength(2);
  });

  it('getValues returns all values', () => {
    const eviction = new CacheEviction<string, string>(makeOptions());

    eviction.set('a', '1');
    eviction.set('b', '2');

    const values = eviction.getValues();
    expect(values).toContain('1');
    expect(values).toContain('2');
    expect(values).toHaveLength(2);
  });

  it('getEntries returns all key-value pairs', () => {
    const eviction = new CacheEviction<string, string>(makeOptions());

    eviction.set('a', '1');
    eviction.set('b', '2');

    const entries = eviction.getEntries();
    expect(entries).toContainEqual(['a', '1']);
    expect(entries).toContainEqual(['b', '2']);
    expect(entries).toHaveLength(2);
  });
});

describe('CacheEviction — Purge Interval Behavior', () => {
  it('triggers purge after PURGE_OPERATION_INTERVAL operations', () => {
    vi.useFakeTimers();

    const evicted: string[] = [];
    // maxSize=50, so purgeInterval = min(50, 100) = 50
    const eviction = new CacheEviction<string, string>({
      maxSize: 50,
      ttlMs: 100,
      onEvict: (key, _value) => evicted.push(key),
    });

    // Set an entry that will expire
    eviction.set('expire-me', 'old');
    vi.advanceTimersByTime(150);

    // Perform 49 more sets (total 50 operations, triggering purge)
    for (let i = 0; i < 49; i++) {
      eviction.set(`key-${i}`, `val-${i}`);
    }

    // 'expire-me' should have been evicted during purge
    expect(eviction.has('expire-me')).toBe(false);

    vi.useRealTimers();
  });

  it('triggers purge after PURGE_TIME_INTERVAL_MS elapses', () => {
    vi.useFakeTimers();

    const evicted: string[] = [];
    const eviction = new CacheEviction<string, string>({
      maxSize: 100, // purgeInterval = min(100, 100) = 100
      ttlMs: 100,
      onEvict: (key, _value) => evicted.push(key),
    });

    // Set an entry that will expire
    eviction.set('expire-me', 'old');
    vi.advanceTimersByTime(150);

    // Advance time beyond PURGE_TIME_INTERVAL_MS (5 minutes)
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    // A single set should trigger purge due to time interval
    eviction.set('trigger', 'value');

    // 'expire-me' should have been evicted
    expect(eviction.has('expire-me')).toBe(false);

    vi.useRealTimers();
  });

  it('resets operationCount after purge', () => {
    vi.useFakeTimers();

    const eviction = new CacheEviction<string, string>({
      maxSize: 10,
      ttlMs: 60_000,
    });

    // Perform some operations
    for (let i = 0; i < 5; i++) {
      eviction.set(`key-${i}`, `val-${i}`);
    }

    const statsBefore = eviction.getStats();
    expect(statsBefore.operationsSincePurge).toBe(5);

    // Trigger purge by advancing time
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    eviction.set('trigger', 'value');

    const statsAfter = eviction.getStats();
    // After purge, operationsSincePurge should be reset (then incremented by the trigger set)
    expect(statsAfter.operationsSincePurge).toBeLessThan(statsBefore.operationsSincePurge + 1);

    vi.useRealTimers();
  });

  it('purgeInterval is min(maxSize, PURGE_OPERATION_INTERVAL)', () => {
    // maxSize < 100, so purgeInterval = maxSize
    const smallCache = new CacheEviction<string, string>({
      maxSize: 50,
      ttlMs: 60_000,
    });
    expect(smallCache.getStats().purgeInterval).toBe(50);

    // maxSize > 100, so purgeInterval = 100
    const largeCache = new CacheEviction<string, string>({
      maxSize: 200,
      ttlMs: 60_000,
    });
    expect(largeCache.getStats().purgeInterval).toBe(100);

    // maxSize = 100, so purgeInterval = 100
    const exactCache = new CacheEviction<string, string>({
      maxSize: 100,
      ttlMs: 60_000,
    });
    expect(exactCache.getStats().purgeInterval).toBe(100);
  });

  it('does not purge when neither threshold is met', () => {
    vi.useFakeTimers();

    const evicted: string[] = [];
    const eviction = new CacheEviction<string, string>({
      maxSize: 100, // purgeInterval = 100
      ttlMs: 100,
      onEvict: (key, _value) => evicted.push(key),
    });

    // Set an entry that will expire
    eviction.set('expire-me', 'old');
    vi.advanceTimersByTime(150);

    // Perform only 5 operations (well below threshold)
    for (let i = 0; i < 5; i++) {
      eviction.set(`key-${i}`, `val-${i}`);
    }

    // 'expire-me' should still be in the map (purge not triggered)
    // Note: has() will return false because it's expired, but the entry
    // should still exist in the map until purge runs
    const internalMap = eviction.getMap();
    expect(internalMap.has('expire-me')).toBe(true);

    vi.useRealTimers();
  });
});

describe('CacheEviction — Edge Cases', () => {
  it('get on non-existent key returns undefined', () => {
    const eviction = new CacheEviction<string, string>(makeOptions());
    expect(eviction.get('nonexistent')).toBe(undefined);
  });

  it('has on non-existent key returns false', () => {
    const eviction = new CacheEviction<string, string>(makeOptions());
    expect(eviction.has('nonexistent')).toBe(false);
  });

  it('set overwrites existing key value', () => {
    const eviction = new CacheEviction<string, string>(makeOptions());

    eviction.set('a', 'original');
    eviction.set('a', 'updated');

    expect(eviction.get('a')).toBe('updated');
    expect(eviction.getStats().size).toBe(1);
  });

  it('handles numeric keys', () => {
    const eviction = new CacheEviction<number, string>(makeOptions());

    eviction.set(1, 'one');
    eviction.set(2, 'two');

    expect(eviction.get(1)).toBe('one');
    expect(eviction.get(2)).toBe('two');
    expect(eviction.has(1)).toBe(true);
  });

  it('getMap returns the internal map reference', () => {
    const eviction = new CacheEviction<string, string>(makeOptions());

    eviction.set('a', '1');
    const map = eviction.getMap();

    expect(map).toBeInstanceOf(Map);
    expect(map.size).toBe(1);
    expect(map.get('a')?.value).toBe('1');
  });
});
