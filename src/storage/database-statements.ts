import { DatabaseSync } from 'node:sqlite';

/**
 * Production-grade prepared-statement cache.
 *
 * Design notes:
 * - Statements are keyed PER DATABASE INSTANCE. The previous single
 *   Map<sql, stmt> cache had a latent bug: after closeDatabase() + re-init
 *   (tests, project switch) a stale statement prepared against the OLD
 *   connection was handed out, and two live databases would collide.
 * - LRU eviction with a per-database capacity cap. Distinct SQL strings in
 *   a long-lived process (the MCP server) are bounded in practice, but the
 *   map should not retain unbounded growth; 512 covers this codebase's
 *   real surface ~10x over.
 * - Hit/miss/prepare/eviction statistics for observability.
 */

/** Default max cached statements per database instance. */
export const STATEMENT_CACHE_CAPACITY = 512;

type Statement = ReturnType<DatabaseSync['prepare']>;

export interface StatementCacheStats {
  size: number;
  capacity: number;
  hits: number;
  misses: number;
  prepares: number;
  evictions: number;
  hitRate: number;
}

function emptyStats(): StatementCacheStats {
  return { size: 0, capacity: STATEMENT_CACHE_CAPACITY, hits: 0, misses: 0, prepares: 0, evictions: 0, hitRate: 0 };
}

/** LRU statement cache bound to ONE database instance. */
class PerDatabaseStatementCache {
  private readonly cache = new Map<string, Statement>();
  private hits = 0;
  private misses = 0;
  private prepares = 0;
  private evictions = 0;

  constructor(private readonly db: DatabaseSync) {}

  get(sql: string): Statement {
    const existing = this.cache.get(sql);
    if (existing) {
      // LRU refresh: re-insert moves the key to MRU position.
      this.cache.delete(sql);
      this.cache.set(sql, existing);
      this.hits++;
      return existing;
    }
    this.misses++;
    const stmt = this.db.prepare(sql);
    this.prepares++;
    if (this.cache.size >= STATEMENT_CACHE_CAPACITY) {
      // Evict least-recently-used = first key of insertion-order Map.
      const lruKey = this.cache.keys().next().value as string | undefined;
      if (lruKey !== undefined) {
        this.cache.delete(lruKey);
        this.evictions++;
      }
    }
    this.cache.set(sql, stmt);
    return stmt;
  }

  clear(): void {
    this.cache.clear();
  }

  stats(): StatementCacheStats {
    const total = this.hits + this.misses;
    return {
      size: this.cache.size,
      capacity: STATEMENT_CACHE_CAPACITY,
      hits: this.hits,
      misses: this.misses,
      prepares: this.prepares,
      evictions: this.evictions,
      hitRate: total > 0 ? this.hits / total : 0,
    };
  }
}

/**
 * WeakMap keyed by database instance: when a DatabaseSync is closed/GC'd its
 * whole statement cache goes with it automatically — no leak, no stale
 * statements across re-initializations. A separate tracking Set exists ONLY
 * so explicit "clear all / stats all" operations remain possible.
 */
const cachesByDb = new WeakMap<DatabaseSync, PerDatabaseStatementCache>();
const trackedDatabases = new Set<DatabaseSync>();

function cacheFor(db: DatabaseSync): PerDatabaseStatementCache {
  let c = cachesByDb.get(db);
  if (!c) {
    c = new PerDatabaseStatementCache(db);
    cachesByDb.set(db, c);
    trackedDatabases.add(db);
  }
  return c;
}

/**
 * Get (or prepare-and-cache) a prepared statement for `sql` on `db`.
 *
 * Signature-compatible with the legacy implementation; additionally the
 * `db` argument now actually matters (per-instance caching).
 */
export function getStatement(sql: string, db: DatabaseSync): Statement {
  return cacheFor(db).get(sql);
}

/** Clear one database's statement cache, or every live database's when omitted. */
export function clearStatementCache(db?: DatabaseSync): void {
  if (db) {
    cachesByDb.get(db)?.clear();
    return;
  }
  for (const live of trackedDatabases) {
    cachesByDb.get(live)?.clear();
  }
}

/**
 * Cache statistics for one database, or for every live database keyed by
 * open state when omitted (databases hold no usable identity string here).
 */
export function getStatementCacheStats(db?: DatabaseSync): StatementCacheStats | Record<string, StatementCacheStats> {
  if (db) {
    const c = cachesByDb.get(db);
    return c ? c.stats() : emptyStats();
  }
  const all: Record<string, StatementCacheStats> = {};
  for (const [i, live] of [...trackedDatabases].entries()) {
    const c = cachesByDb.get(live);
    if (c)     all[`db-${i}-${live.isOpen ? 'open' : 'closed'}`] = c.stats();
  }
  return all;
}
