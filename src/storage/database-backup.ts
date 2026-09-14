import { copyFileSync, existsSync, unlinkSync, renameSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, resolve } from 'node:path';

export interface DatabaseBackupValidation {
  valid: boolean;
  integrity: string;
  schemaVersion: number | null;
  details: string[];
}

function removeIfPresent(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}

function readSchemaVersion(db: DatabaseSync): number | null {
  try {
    const row = db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as
      { version?: number | bigint | null } | undefined;
    if (row?.version === undefined || row.version === null) return null;
    const version = Number(row.version);
    return Number.isSafeInteger(version) && version >= 0 ? version : null;
  } catch {
    return null;
  }
}

/**
 * Create a consistent SQLite snapshot without copying a live WAL file.
 * The destination must be resolved and confined by the caller.
 */
export function createDatabaseBackup(db: DatabaseSync, destinationPath: string): void {
  const destination = resolve(destinationPath);
  if (existsSync(destination)) {
    throw new Error(`Database backup destination already exists: ${destinationPath}`);
  }
  const directory = dirname(destination);
  if (!existsSync(directory)) {
    throw new Error(`Database backup directory does not exist: ${directory}`);
  }
  try {
    db.prepare('VACUUM INTO ?').run(destination);
    const validation = validateDatabaseBackup(destination);
    if (!validation.valid) {
      throw new Error(
        `Created database backup failed integrity verification: ${validation.details.join('; ')}`,
      );
    }
  } catch (error) {
    removeIfPresent(destination);
    throw error;
  }
}

/** Validate a backup before it can be used for restore. */
export function validateDatabaseBackup(backupPath: string): DatabaseBackupValidation {
  const path = resolve(backupPath);
  if (!existsSync(path)) {
    return {
      valid: false,
      integrity: 'missing',
      schemaVersion: null,
      details: ['The database backup file does not exist.'],
    };
  }

  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const row = db.prepare('PRAGMA integrity_check').get() as { integrity_check?: unknown };
    const integrity = String(row?.integrity_check ?? 'unknown');
    const schemaVersion = readSchemaVersion(db);
    const details = integrity === 'ok' ? [] : [`SQLite integrity check returned: ${integrity}`];
    if (schemaVersion === null)
      details.push('The backup has no readable ProjectMind schema version.');
    return { valid: details.length === 0, integrity, schemaVersion, details };
  } catch (error) {
    return {
      valid: false,
      integrity: 'unreadable',
      schemaVersion: null,
      details: [
        `The database backup could not be opened read-only: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  } finally {
    db?.close();
  }
}

/**
 * Replace a closed database with a validated snapshot. The caller must close
 * the active ProjectMind connection first; the exact old database is retained
 * only until the replacement succeeds, then temporary files are removed.
 */
export function restoreDatabaseFile(databasePath: string, backupPath: string): void {
  const database = resolve(databasePath);
  const backup = resolve(backupPath);
  if (database === backup) throw new Error('Database backup and restore paths must be different.');
  const validation = validateDatabaseBackup(backup);
  if (!validation.valid) {
    throw new Error(`Database backup is not restorable: ${validation.details.join('; ')}`);
  }

  const suffix = `${process.pid}-${Date.now()}`;
  const staged = `${database}.projectmind-restore-${suffix}.tmp`;
  const previous = `${database}.projectmind-restore-${suffix}.bak`;
  const hadDatabase = existsSync(database);
  let previousExists = false;
  try {
    copyFileSync(backup, staged);
    if (hadDatabase) {
      renameSync(database, previous);
      previousExists = true;
    }
    removeIfPresent(`${database}-wal`);
    removeIfPresent(`${database}-shm`);
    renameSync(staged, database);
    removeIfPresent(previous);
    previousExists = false;
  } catch (error) {
    removeIfPresent(staged);
    if (hadDatabase && !existsSync(database) && existsSync(previous)) {
      try {
        renameSync(previous, database);
        previousExists = false;
      } catch {
        // Preserve the previous database if Windows/OneDrive still holds the
        // target. The original error remains the actionable failure signal.
      }
    }
    throw error;
  } finally {
    removeIfPresent(staged);
    // Never delete the only remaining copy when rollback itself was blocked.
    if (!previousExists) removeIfPresent(previous);
  }
}
