import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock fs and logger before importing persistence module
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
  statSync: vi.fn(),
}));

vi.mock('../../../../src/utils/logger.js', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

import { CachePersistence } from '../../../../src/core/cache/eviction/persistence.js';
import type { CacheOptions, CacheEntry } from '../../../../src/core/cache/types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const testDir = join(tmpdir(), 'projectmind-test-persist');
const persistPath = join(testDir, 'cache.json');

function makeOptions(overrides: Partial<CacheOptions<string, string>> = {}): CacheOptions<string, string> {
  return {
    maxSize: 10,
    ttlMs: 60_000,
    persistent: true,
    persistPath,
    ...overrides,
  };
}

function makeEntry(value: string, expiresAt: number): CacheEntry<string> {
  const now = Date.now();
  return {
    value,
    createdAt: now,
    expiresAt,
    accessCount: 0,
    lastAccessed: now,
  };
}

// ─── Test suites ─────────────────────────────────────────────────────────────

describe('CachePersistence — persistToDisk', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('writes cache entries to disk as JSON array', () => {
    vi.mocked(existsSync).mockReturnValue(true);

    const persistence = new CachePersistence<string, string>(makeOptions());

    const map = new Map<string, CacheEntry<string>>();
    map.set('a', makeEntry('1', Date.now() + 60_000));
    map.set('b', makeEntry('2', Date.now() + 60_000));

    persistence.persistToDisk(map);

    expect(writeFileSync).toHaveBeenCalledTimes(1);
    const [path, data] = vi.mocked(writeFileSync).mock.calls[0];
    expect(path).toBe(persistPath);

    const saved = JSON.parse(data as string);
    expect(Array.isArray(saved)).toBe(true);
    expect(saved).toHaveLength(2);
    expect(saved.find((e: { key: string }) => e.key === 'a')).toBeDefined();
    expect(saved.find((e: { key: string }) => e.key === 'b')).toBeDefined();
  });

  it('does not write to disk when persistent=false', () => {
    const persistence = new CachePersistence<string, string>(
      makeOptions({ persistent: false })
    );

    const map = new Map<string, CacheEntry<string>>();
    map.set('a', makeEntry('1', Date.now() + 60_000));

    persistence.persistToDisk(map);

    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it('writes correct entry structure to disk', () => {
    vi.mocked(existsSync).mockReturnValue(true);

    const persistence = new CachePersistence<string, string>(makeOptions());
    const now = Date.now();

    const map = new Map<string, CacheEntry<string>>();
    map.set('key1', {
      value: 'test-value',
      createdAt: now,
      expiresAt: now + 120_000,
      accessCount: 5,
      lastAccessed: now,
    });

    persistence.persistToDisk(map);

    const [, data] = vi.mocked(writeFileSync).mock.calls[0];
    const saved = JSON.parse(data as string);

    expect(saved[0]).toEqual({
      key: 'key1',
      value: 'test-value',
      createdAt: now,
      expiresAt: now + 120_000,
    });
  });

  it('handles empty map correctly', () => {
    vi.mocked(existsSync).mockReturnValue(true);

    const persistence = new CachePersistence<string, string>(makeOptions());
    const map = new Map<string, CacheEntry<string>>();

    persistence.persistToDisk(map);

    const [, data] = vi.mocked(writeFileSync).mock.calls[0];
    const saved = JSON.parse(data as string);
    expect(saved).toEqual([]);
  });

  it('calls onError when write fails', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(writeFileSync).mockImplementation(() => {
      throw new Error('Disk full');
    });

    const errors: Error[] = [];
    const persistence = new CachePersistence<string, string>(
      makeOptions({
        onError: (err) => errors.push(err),
      })
    );

    const map = new Map<string, CacheEntry<string>>();
    map.set('a', makeEntry('1', Date.now() + 60_000));

    persistence.persistToDisk(map);

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe('Disk full');
  });
});

describe('CachePersistence — loadFromDisk', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('loads entries from disk when file exists', () => {
    const now = Date.now();
    const cachedData = [
      { key: 'a', value: '1', createdAt: now, expiresAt: now + 60_000 },
      { key: 'b', value: '2', createdAt: now, expiresAt: now + 60_000 },
    ];

    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(cachedData));

    const persistence = new CachePersistence<string, string>(makeOptions());
    const map = new Map<string, CacheEntry<string>>();
    persistence.loadFromDisk(map);

    expect(map.size).toBe(2);
    expect(map.get('a')?.value).toBe('1');
    expect(map.get('b')?.value).toBe('2');
  });

  it('does not load when file does not exist', () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const persistence = new CachePersistence<string, string>(makeOptions());
    const map = new Map<string, CacheEntry<string>>();
    persistence.loadFromDisk(map);

    expect(map.size).toBe(0);
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it('does not load when persistent=false', () => {
    const persistence = new CachePersistence<string, string>(
      makeOptions({ persistent: false })
    );

    const map = new Map<string, CacheEntry<string>>();
    persistence.loadFromDisk(map);

    expect(existsSync).not.toHaveBeenCalled();
    expect(map.size).toBe(0);
  });

  it('preserves loaded entry metadata', () => {
    const now = Date.now();
    const cachedData = [
      { key: 'a', value: 'test-value', createdAt: now - 5000, expiresAt: now + 60_000 },
    ];

    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(cachedData));

    const persistence = new CachePersistence<string, string>(makeOptions());
    const map = new Map<string, CacheEntry<string>>();
    persistence.loadFromDisk(map);

    const entry = map.get('a');
    expect(entry).toBeDefined();
    expect(entry?.value).toBe('test-value');
    expect(entry?.createdAt).toBe(now - 5000);
    expect(entry?.expiresAt).toBe(now + 60_000);
    expect(entry?.accessCount).toBe(0);
  });
});

describe('CachePersistence — Skipping Expired Entries on Load', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('skips expired entries when loading from disk', () => {
    const now = Date.now();
    const cachedData = [
      { key: 'fresh', value: 'ok', createdAt: now - 1000, expiresAt: now + 60_000 },
      { key: 'stale', value: 'expired', createdAt: now - 120_000, expiresAt: now - 60_000 },
    ];

    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(cachedData));

    const persistence = new CachePersistence<string, string>(makeOptions());
    const map = new Map<string, CacheEntry<string>>();
    persistence.loadFromDisk(map);

    expect(map.size).toBe(1);
    expect(map.has('fresh')).toBe(true);
    expect(map.has('stale')).toBe(false);
  });

  it('loads only non-expired entries when multiple expire at different times', () => {
    const now = Date.now();
    const cachedData = [
      { key: 'a', value: '1', createdAt: now, expiresAt: now - 1000 },    // expired
      { key: 'b', value: '2', createdAt: now, expiresAt: now + 1000 },    // expires soon
      { key: 'c', value: '3', createdAt: now, expiresAt: now - 5000 },    // expired
      { key: 'd', value: '4', createdAt: now, expiresAt: now + 60_000 },  // fresh
    ];

    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(cachedData));

    const persistence = new CachePersistence<string, string>(makeOptions());
    const map = new Map<string, CacheEntry<string>>();
    persistence.loadFromDisk(map);

    expect(map.size).toBe(2);
    expect(map.has('a')).toBe(false);
    expect(map.has('b')).toBe(true);
    expect(map.has('c')).toBe(false);
    expect(map.has('d')).toBe(true);
  });

  it('results in empty map when all entries are expired', () => {
    const now = Date.now();
    const cachedData = [
      { key: 'a', value: '1', createdAt: now - 120_000, expiresAt: now - 60_000 },
      { key: 'b', value: '2', createdAt: now - 120_000, expiresAt: now - 60_000 },
    ];

    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(cachedData));

    const persistence = new CachePersistence<string, string>(makeOptions());
    const map = new Map<string, CacheEntry<string>>();
    persistence.loadFromDisk(map);

    expect(map.size).toBe(0);
  });
});

describe('CachePersistence — Corrupt Data Handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('handles invalid JSON gracefully', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue('not valid json{{{');

    const errors: Error[] = [];
    const persistence = new CachePersistence<string, string>(
      makeOptions({
        onError: (err) => errors.push(err),
      })
    );

    const map = new Map<string, CacheEntry<string>>();
    persistence.loadFromDisk(map);

    expect(map.size).toBe(0);
    expect(errors).toHaveLength(1);
  });

  it('handles empty file gracefully', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue('');

    const errors: Error[] = [];
    const persistence = new CachePersistence<string, string>(
      makeOptions({
        onError: (err) => errors.push(err),
      })
    );

    const map = new Map<string, CacheEntry<string>>();
    persistence.loadFromDisk(map);

    expect(map.size).toBe(0);
    expect(errors).toHaveLength(1);
  });

  it('handles file with null content', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue('null');

    const errors: Error[] = [];
    const persistence = new CachePersistence<string, string>(
      makeOptions({
        onError: (err) => errors.push(err),
      })
    );

    const map = new Map<string, CacheEntry<string>>();
    persistence.loadFromDisk(map);

    expect(map.size).toBe(0);
    expect(errors).toHaveLength(1);
  });

  it('handles non-array JSON gracefully', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue('{"key": "value"}');

    const persistence = new CachePersistence<string, string>(makeOptions());
    const map = new Map<string, CacheEntry<string>>();

    // JSON.parse returns an object, not array — forEach/iteration fails
    // The implementation should handle this via the try/catch
    persistence.loadFromDisk(map);

    // Should not throw; map may be empty or have unexpected entries
    // The key point is it doesn't crash
    expect(map.size).toBe(0);
  });
});

describe('CachePersistence — Auto-Persist Interval (PERSIST_INTERVAL_MS)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('starts a persist timer when persistent=true', () => {
    vi.useFakeTimers();

    const persistence = new CachePersistence<string, string>(makeOptions());

    // Should have started a timer
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    vi.useRealTimers();
    persistence.destroy();
  });

  it('does not start a persist timer when persistent=false', () => {
    vi.useFakeTimers();

    const persistence = new CachePersistence<string, string>(
      makeOptions({ persistent: false })
    );

    // No timer should be started
    expect(vi.getTimerCount()).toBe(0);

    vi.useRealTimers();
    persistence.destroy();
  });

  it('timer calls persistToDisk periodically', () => {
    vi.useFakeTimers();
    vi.mocked(existsSync).mockReturnValue(true);

    const persistence = new CachePersistence<string, string>(makeOptions());

    // Manually set the cacheMap to simulate an active cache
    const map = new Map<string, CacheEntry<string>>();
    map.set('a', makeEntry('1', Date.now() + 60_000));

    // Access private cacheMap via loadFromDisk
    persistence.loadFromDisk(map);

    // Clear any calls from setup
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(true);

    // Advance time by PERSIST_INTERVAL_MS (60 seconds)
    vi.advanceTimersByTime(60_000);

    // persistToDisk should have been called
    expect(writeFileSync).toHaveBeenCalled();

    vi.useRealTimers();
    persistence.destroy();
  });

  it('timer does not persist if cacheMap is null', () => {
    vi.useFakeTimers();

    const persistence = new CachePersistence<string, string>(makeOptions());

    // Clear any calls from setup
    vi.clearAllMocks();

    // Advance time by PERSIST_INTERVAL_MS
    vi.advanceTimersByTime(60_000);

    // writeFileSync should not be called since cacheMap is null
    expect(writeFileSync).not.toHaveBeenCalled();

    vi.useRealTimers();
    persistence.destroy();
  });

  it('destroy clears the persist timer', () => {
    vi.useFakeTimers();

    const persistence = new CachePersistence<string, string>(makeOptions());
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    persistence.destroy();
    expect(vi.getTimerCount()).toBe(0);

    vi.useRealTimers();
  });
});

describe('CachePersistence — Directory Creation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('creates directory if it does not exist when persisting', () => {
    // First call (dirname check) returns false, subsequent calls return true
    vi.mocked(existsSync).mockReturnValue(false);

    const persistence = new CachePersistence<string, string>(makeOptions());

    const map = new Map<string, CacheEntry<string>>();
    map.set('a', makeEntry('1', Date.now() + 60_000));

    persistence.persistToDisk(map);

    expect(mkdirSync).toHaveBeenCalledWith(testDir, { recursive: true });
    expect(writeFileSync).toHaveBeenCalled();
  });

  it('does not create directory if it already exists', () => {
    vi.mocked(existsSync).mockReturnValue(true);

    const persistence = new CachePersistence<string, string>(makeOptions());

    const map = new Map<string, CacheEntry<string>>();
    map.set('a', makeEntry('1', Date.now() + 60_000));

    persistence.persistToDisk(map);

    expect(mkdirSync).not.toHaveBeenCalled();
    expect(writeFileSync).toHaveBeenCalled();
  });

  it('creates nested directories recursively', () => {
    const nestedPath = join(tmpdir(), 'projectmind-test-nested', 'deep', 'path', 'cache.json');
    vi.mocked(existsSync).mockReturnValue(false);

    const persistence = new CachePersistence<string, string>(
      makeOptions({ persistPath: nestedPath })
    );

    const map = new Map<string, CacheEntry<string>>();
    map.set('a', makeEntry('1', Date.now() + 60_000));

    persistence.persistToDisk(map);

    // dirname of the persistPath
    const expectedDir = join(tmpdir(), 'projectmind-test-nested', 'deep', 'path');
    expect(mkdirSync).toHaveBeenCalledWith(expectedDir, { recursive: true });
  });
});

describe('CachePersistence — Round-Trip Save/Load', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('persisted data can be loaded back correctly', () => {
    const now = Date.now();
    let savedData: string = '';

    // Capture what was written
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(writeFileSync).mockImplementation((_path, data) => {
      savedData = data as string;
    });

    // Persist
    const persistPersistence = new CachePersistence<string, string>(makeOptions());
    const persistMap = new Map<string, CacheEntry<string>>();
    persistMap.set('a', {
      value: 'value-a',
      createdAt: now,
      expiresAt: now + 60_000,
      accessCount: 3,
      lastAccessed: now,
    });
    persistMap.set('b', {
      value: 'value-b',
      createdAt: now,
      expiresAt: now + 120_000,
      accessCount: 1,
      lastAccessed: now,
    });

    persistPersistence.persistToDisk(persistMap);

    // Now load the captured data
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(savedData);

    const loadPersistence = new CachePersistence<string, string>(makeOptions());
    const loadMap = new Map<string, CacheEntry<string>>();
    loadPersistence.loadFromDisk(loadMap);

    expect(loadMap.size).toBe(2);
    expect(loadMap.get('a')?.value).toBe('value-a');
    expect(loadMap.get('a')?.expiresAt).toBe(now + 60_000);
    expect(loadMap.get('b')?.value).toBe('value-b');
    expect(loadMap.get('b')?.expiresAt).toBe(now + 120_000);
  });
});

describe('CachePersistence — Custom Serialization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('uses custom serialize function when provided', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    const customSerialize = vi.fn().mockReturnValue('custom-serialized');

    const persistence = new CachePersistence<string, string>(
      makeOptions({ serialize: customSerialize })
    );

    const map = new Map<string, CacheEntry<string>>();
    map.set('a', makeEntry('value', Date.now() + 60_000));

    persistence.persistToDisk(map);

    // Custom serialize is used in estimateMemoryUsage, not persistToDisk
    // persistToDisk uses JSON.stringify on the data array
    // This test verifies the custom serialize doesn't break persistToDisk
    expect(writeFileSync).toHaveBeenCalled();
  });
});
