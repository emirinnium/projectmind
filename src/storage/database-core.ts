import { DatabaseSync } from 'node:sqlite';
import { runMigrations, getCurrentSchemaVersion } from './migrations.js';
import { SCHEMA_SQL } from './schema.js';
import { existsSync } from 'node:fs';
import { logger } from '../utils/logger.js';
import { clearStatementCache } from './database-statements.js';

// ===== Singleton Instance (default, backward compatible) =====

let _instance: DatabaseSync | null = null;

// ===== DatabaseManager Class (Dependency Injection Support) =====

export class DatabaseManager {
  private db: DatabaseSync | null = null;
  private readonly stmtCache = new Map<string, ReturnType<DatabaseSync['prepare']>>();
  private transactionDepth = 0;

  constructor(private readonly dbPath?: string) {}

  init(): DatabaseSync {
    if (this.db) return this.db;

    if (this.dbPath) {
      this.handleWalFiles(this.dbPath);
    }

    this.db = new DatabaseSync(this.dbPath || ':memory:', { allowExtension: true });
    this.configurePragmas(this.db);
    this.db.exec(SCHEMA_SQL);
    runMigrations(this.db);
    this.stmtCache.clear();
    return this.db;
  }

  getDb(): DatabaseSync {
    if (!this.db) {
      throw new Error('DatabaseManager not initialized. Call init() first.');
    }
    return this.db;
  }

  isInitialized(): boolean {
    return this.db !== null;
  }

  getStatement(sql: string): ReturnType<DatabaseSync['prepare']> {
    const db = this.getDb();
    let stmt = this.stmtCache.get(sql);
    if (!stmt) {
      stmt = db.prepare(sql);
      this.stmtCache.set(sql, stmt);
    }
    return stmt;
  }

  runInTransaction<T>(fn: (db: DatabaseSync) => T): T {
    const db = this.getDb();
    const isNested = this.transactionDepth > 0;
    const savepointName = `sp_${this.transactionDepth}_${++_savepointCounter}`;

    this.transactionDepth++;

    try {
      if (isNested) {
        db.exec(`SAVEPOINT ${savepointName}`);
      } else {
        db.exec('BEGIN IMMEDIATE');
      }

      const result = fn(db);

      if (isNested) {
        db.exec(`RELEASE SAVEPOINT ${savepointName}`);
      } else {
        db.exec('COMMIT');
      }

      return result;
    } catch (e) {
      this.rollbackTransaction(db, isNested, savepointName);
      throw e;
    } finally {
      this.transactionDepth--;
    }
  }

  isInTransaction(): boolean {
    return this.transactionDepth > 0;
  }

  getSchemaVersion(): number {
    if (!this.db) return 0;
    return getCurrentSchemaVersion(this.db);
  }

  close(): void {
    if (this.db) {
      try {
        this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch {
        // Ignore checkpoint errors
      }
      this.db.close();
      this.db = null;
    }
    this.stmtCache.clear();
    this.transactionDepth = 0;
  }

  private configurePragmas(db: DatabaseSync): void {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA temp_store = MEMORY');
    db.exec('PRAGMA cache_size = -64000');
  }

  /**
   * K7: Never DELETE -wal/-shm files. A WAL file can hold committed-but-
   * uncheckpointed transactions; unlinking it silently DROPS that data.
   * SQLite replays the WAL automatically on the next open, so a failed
   * checkpoint is not a problem — the files are simply left in place.
   */
  private handleWalFiles(dbPath: string): void {
    const walPath = dbPath + '-wal';
    const shmPath = dbPath + '-shm';
    if (!existsSync(walPath) && !existsSync(shmPath)) return;
    try {
      const tempDb = new DatabaseSync(dbPath);
      tempDb.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      tempDb.close();
    } catch (e) {
      logger.warn(
        `WAL files present for ${dbPath} but checkpoint failed — left untouched; SQLite will recover on next open: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  private rollbackTransaction(db: DatabaseSync, isNested: boolean, savepointName: string): void {
    if (isNested) {
      try {
        db.exec(`ROLLBACK TO SAVEPOINT ${savepointName}`);
        db.exec(`RELEASE SAVEPOINT ${savepointName}`);
      } catch {
        // If rollback fails, the outer transaction will handle it
      }
    } else {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Ignore rollback errors
      }
    }
  }
}

// ===== Singleton Functions =====

export function initDatabase(dbPath: string): DatabaseSync {
  if (_instance) {
    _instance.close();
    _instance = null;
  }

  try {
    const walPath = dbPath + '-wal';
    const shmPath = dbPath + '-shm';
    if (existsSync(walPath) || existsSync(shmPath)) {
      const tempDb = new DatabaseSync(dbPath);
      tempDb.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      tempDb.close();
    }
  } catch (e) {
    // K7: never unlink -wal/-shm here — they may hold committed transactions.
    // SQLite replays them on the next open; a checkpoint failure is benign.
    logger.warn(`WAL checkpoint failed for ${dbPath} — files left untouched: ${e instanceof Error ? e.message : String(e)}`);
  }

  _instance = new DatabaseSync(dbPath, { allowExtension: true });
  _instance.exec('PRAGMA journal_mode = WAL');
  _instance.exec('PRAGMA foreign_keys = ON');
  _instance.exec('PRAGMA synchronous = NORMAL');
  _instance.exec('PRAGMA temp_store = MEMORY');
  _instance.exec('PRAGMA cache_size = -64000');

  _instance.exec(SCHEMA_SQL);
  runMigrations(_instance);

  clearStatementCache();
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
  clearStatementCache();
}

export function closeDatabase(): void {
  if (_instance) {
    try {
      _instance.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch (e) {
      logger.warn(`WAL checkpoint failed during close: ${e instanceof Error ? e.message : String(e)}`);
    }
    _instance.close();
    _instance = null;
  }
  clearStatementCache();
}

export function getSchemaVersion(): number {
  if (!_instance) return 0;
  return getCurrentSchemaVersion(_instance);
}

let _savepointCounter = 0;
let _transactionDepth = 0;

export function runInTransaction<T>(fn: (db: DatabaseSync) => T): T {
  const db = getDatabase();
  const isNested = _transactionDepth > 0;
  const savepointName = `sp_${_transactionDepth}_${++_savepointCounter}`;

  _transactionDepth++;

  try {
    if (isNested) {
      db.exec(`SAVEPOINT ${savepointName}`);
    } else {
      db.exec('BEGIN IMMEDIATE');
    }

    const result = fn(db);

    if (isNested) {
      db.exec(`RELEASE SAVEPOINT ${savepointName}`);
    } else {
      db.exec('COMMIT');
    }

    return result;
  } catch (e) {
    if (isNested) {
      try {
        db.exec(`ROLLBACK TO SAVEPOINT ${savepointName}`);
        db.exec(`RELEASE SAVEPOINT ${savepointName}`);
      } catch {
        // If rollback fails, the outer transaction will handle it
      }
    } else {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Ignore rollback errors
      }
    }
    throw e;
  } finally {
    _transactionDepth--;
  }
}

export function isInTransaction(): boolean {
  return _transactionDepth > 0;
}
