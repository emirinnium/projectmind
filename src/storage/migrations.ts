import { DatabaseSync } from 'node:sqlite';
import { logger } from '../utils/logger.js';
import { coreMigrations } from './migrations/core-migrations.js';
import { collaborationMigrations } from './migrations/collaboration-migrations.js';
import { debtMigrations } from './migrations/debt-migrations.js';
import type { Migration } from './migrations/types.js';

const SCHEMA_VERSION_TABLE = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
`;

/** All migrations in version order */
export const migrations: Migration[] = [
  ...coreMigrations,
  ...collaborationMigrations,
  ...debtMigrations,
].sort((a, b) => a.version - b.version);

export function getCurrentSchemaVersion(db: DatabaseSync): number {
  try {
    db.exec(SCHEMA_VERSION_TABLE);
    const result = db.prepare('SELECT MAX(version) as version FROM schema_version').get() as { version: number | null } | undefined;
    return result?.version || 0;
  } catch {
    return 0;
  }
}

export function setSchemaVersion(db: DatabaseSync, version: number, name: string): void {
  db.exec(SCHEMA_VERSION_TABLE);
  db.prepare('INSERT OR REPLACE INTO schema_version (version, name) VALUES (?, ?)').run(version, name);
}

export function removeSchemaVersion(db: DatabaseSync, version: number): void {
  db.exec(SCHEMA_VERSION_TABLE);
  db.prepare('DELETE FROM schema_version WHERE version = ?').run(version);
}

/**
 * Run all pending migrations (up).
 */
export function runMigrations(db: DatabaseSync): void {
  const currentVersion = getCurrentSchemaVersion(db);
  logger.info(`Current schema version: ${currentVersion}`);

  for (const migration of migrations) {
    if (migration.version > currentVersion) {
      logger.info(`Applying migration ${migration.version}: ${migration.name}`);
      try {
        db.exec('BEGIN');
        migration.up(db);
        setSchemaVersion(db, migration.version, migration.name);
        db.exec('COMMIT');
        logger.info(`Migration ${migration.version} applied successfully`);
      } catch (error) {
        db.exec('ROLLBACK');
        logger.error(`Migration ${migration.version} failed: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
    }
  }

  const finalVersion = getCurrentSchemaVersion(db);
  logger.info(`Schema version after migrations: ${finalVersion}`);
}

/**
 * Rollback migrations to a specific target version.
 * Runs down() for all migrations with version > targetVersion, in reverse order.
 */
export function rollbackMigrations(db: DatabaseSync, targetVersion: number): void {
  const currentVersion = getCurrentSchemaVersion(db);
  
  if (targetVersion >= currentVersion) {
    logger.info(`Already at or below version ${targetVersion}. Nothing to rollback.`);
    return;
  }

  logger.info(`Rolling back from version ${currentVersion} to ${targetVersion}`);

  // Get all migrations that need to be rolled back (reverse order)
  const toRollback = migrations
    .filter(m => m.version <= currentVersion && m.version > targetVersion)
    .sort((a, b) => b.version - a.version);

  for (const migration of toRollback) {
    if (!migration.down) {
      throw new Error(`Cannot rollback migration ${migration.version}: ${migration.name} - no down() defined`);
    }
    
    logger.info(`Rolling back migration ${migration.version}: ${migration.name}`);
    try {
      db.exec('BEGIN');
      migration.down(db);
      removeSchemaVersion(db, migration.version);
      db.exec('COMMIT');
      logger.info(`Migration ${migration.version} rolled back successfully`);
    } catch (error) {
      db.exec('ROLLBACK');
      logger.error(`Rollback of migration ${migration.version} failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  const finalVersion = getCurrentSchemaVersion(db);
  logger.info(`Schema version after rollback: ${finalVersion}`);
}

/**
 * Rollback the last N migrations.
 */
export function rollbackLast(db: DatabaseSync, count: number = 1): void {
  const currentVersion = getCurrentSchemaVersion(db);
  const targetVersion = Math.max(0, currentVersion - count);
  rollbackMigrations(db, targetVersion);
}

export function resetSchemaVersion(db: DatabaseSync): void {
  db.exec('DROP TABLE IF EXISTS schema_version');
}
