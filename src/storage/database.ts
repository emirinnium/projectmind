import { DatabaseSync } from 'node:sqlite';

let _instance: DatabaseSync | null = null;

/**
 * Caches prepared statements so we don't re-parse SQL on every query.
 * In hot paths (scan, debt detection), the same statements are executed
 * thousands of times; compiling once and reusing gives a measurable speedup.
 */
const stmtCache = new Map<string, ReturnType<DatabaseSync['prepare']>>();

export function initDatabase(dbPath: string): DatabaseSync {
  if (_instance) {
    _instance.close();
    _instance = null;
  }

  _instance = new DatabaseSync(dbPath);
  _instance.exec('PRAGMA journal_mode = WAL');
  _instance.exec('PRAGMA foreign_keys = ON');
  _instance.exec('PRAGMA synchronous = NORMAL');
  _instance.exec('PRAGMA temp_store = MEMORY');
  _instance.exec('PRAGMA cache_size = -64000'); // ~64 MB page cache

  stmtCache.clear();
  return _instance;
}

export function getDatabase(): DatabaseSync {
  if (!_instance) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return _instance;
}

export function setDatabase(db: DatabaseSync): void {
  _instance = db;
  stmtCache.clear();
}

/**
 * Fetch a cached prepared statement for the given SQL, creating and
 * storing it on first use. All callers share the same compiled object.
 */
export function getStatement(sql: string): ReturnType<DatabaseSync['prepare']> {
  const db = getDatabase();
  let stmt = stmtCache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    stmtCache.set(sql, stmt);
  }
  return stmt;
}

export function closeDatabase(): void {
  if (_instance) {
    _instance.close();
    _instance = null;
  }
  stmtCache.clear();
}

export function runInTransaction<T>(fn: (db: DatabaseSync) => T): T {
  const db = getDatabase();
  db.exec('BEGIN');
  try {
    const result = fn(db);
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  retryableErrors?: string[];
  onRetry?: (attempt: number, error: Error) => void;
}

/**
 * Retry a database operation with exponential backoff
 */
export async function runWithRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    baseDelayMs = 100,
    maxDelayMs = 10000,
    backoffMultiplier = 2,
    retryableErrors = ['SQLITE_BUSY', 'SQLITE_LOCKED', 'database is locked', 'timeout', 'network', 'ECONNREFUSED', 'ETIMEDOUT', 'rate limit', '429', '500', '502', '503'],
    onRetry,
  } = options;

  let lastError: Error;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Check if error is retryable
      const isRetryable = retryableErrors.some(e => lastError.message.includes(e));

      if (!isRetryable || attempt === maxAttempts) {
        throw lastError;
      }

      const delay = Math.min(
        baseDelayMs * Math.pow(backoffMultiplier, attempt - 1),
        maxDelayMs
      );

      if (onRetry) {
        onRetry(attempt, lastError);
      }

      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError!;
}
