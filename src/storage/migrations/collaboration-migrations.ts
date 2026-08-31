import type { DatabaseSync } from 'node:sqlite';
import type { Migration } from './types.js';

/**
 * Migrations 92-95: Pattern origin, collaboration, pending intents,
 * debt change frequency, project ID backfill, and FK cascades.
 */
export const collaborationMigrations: Migration[] = [
  {
    version: 92,
    name: 'add_pattern_origin_and_collaboration',
    up: (db: DatabaseSync) => {
      // Check if columns exist before adding (schema may already include them)
      const patternsExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='patterns'").get();
      const teamExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='team_memories'").get();
      if (patternsExists) {
        const patternsCols = db.prepare("PRAGMA table_info(patterns)").all() as Array<{name: string}>;
        if (!patternsCols.find(c => c.name === 'project_id')) {
          db.exec(`ALTER TABLE patterns ADD COLUMN project_id INTEGER;`);
        }
        db.exec(`CREATE INDEX IF NOT EXISTS idx_patterns_project ON patterns(project_id);`);
      }
      if (teamExists) {
        const teamCols = db.prepare("PRAGMA table_info(team_memories)").all() as Array<{name: string}>;
        if (!teamCols.find(c => c.name === 'project_id')) {
          db.exec(`ALTER TABLE team_memories ADD COLUMN project_id INTEGER;`);
        }
        db.exec(`CREATE INDEX IF NOT EXISTS idx_team_memories_project ON team_memories(project_id);`);
      }
      // Ensure pending_intents table exists with correct schema
      const pendingExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pending_intents'").get();
      if (!pendingExists) {
        db.exec(`CREATE TABLE pending_intents (
          id VARCHAR(36) PRIMARY KEY,
          agent_id VARCHAR(255) NOT NULL,
          intent_type VARCHAR(20) NOT NULL,
          target_files TEXT,
          expected_changes TEXT,
          timestamp INTEGER DEFAULT (strftime('%s', 'now')),
          ttl_seconds INTEGER DEFAULT 300
        );`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_pending_intents_timestamp ON pending_intents(timestamp);`);
      } else {
        // If table exists but missing timestamp column, add it.
        const pendingCols = db.prepare("PRAGMA table_info(pending_intents)").all() as Array<{name: string}>;
        const colNames = new Set(pendingCols.map((c) => c.name));
        if (!colNames.has('timestamp') && !colNames.has('expires_at')) {
          db.exec(`ALTER TABLE pending_intents ADD COLUMN timestamp INTEGER DEFAULT 0;`);
          db.exec(`CREATE INDEX IF NOT EXISTS idx_pending_intents_timestamp ON pending_intents(timestamp);`);
        } else if (colNames.has('timestamp')) {
          // Legacy table that already carries the column — ensure its index.
          db.exec(`CREATE INDEX IF NOT EXISTS idx_pending_intents_timestamp ON pending_intents(timestamp);`);
        }
      }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_pending_intents_agent ON pending_intents(agent_id);`);
    },
    down: (db: DatabaseSync) => {
      db.exec('DROP INDEX IF EXISTS idx_patterns_project;');
      db.exec('DROP INDEX IF EXISTS idx_team_memories_project;');
      db.exec('ALTER TABLE patterns DROP COLUMN project_id;');
      db.exec('ALTER TABLE team_memories DROP COLUMN project_id;');
      db.exec('DROP TABLE IF EXISTS pending_intents;');
    },
  },
  {
    version: 93,
    name: 'pending_intents_unix_ms',
    up: (db: DatabaseSync) => {
      // F40/F20: reconcile BOTH legacy pending_intents shapes into the
      // canonical runtime shape (schema.ts): INTEGER unix-millisecond
      // broadcast_at / expires_at. Idempotent — canonical tables no-op.
      const tableExists = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pending_intents'")
        .get();
      if (!tableExists) return; // fresh DBs get the canonical shape from SCHEMA_SQL.

      const cols = db.prepare('PRAGMA table_info(pending_intents)').all() as Array<{ name: string; type: string }>;
      const colTypes = new Map<string, string>(cols.map((c) => [c.name, (c.type || '').toUpperCase()]));
      const hasExpires = colTypes.has('expires_at');
      const hasBroadcast = colTypes.has('broadcast_at');

      // Indexes defined by explicit SQL (sqlite_autoindex_* excluded).
      const userIndexes = db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'pending_intents' AND sql IS NOT NULL")
        .all() as Array<{ sql: string }>;

      // Canonical DDL — exact copy of schema.ts pending_intents.
      const canonicalDdl = (name: string): string => `
        CREATE TABLE ${name} (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          agent_id TEXT NOT NULL,
          intent_type TEXT NOT NULL CHECK(intent_type IN ('read','write','refactor','delete')),
          target_files TEXT NOT NULL,
          session_id TEXT,
          description TEXT,
          expected_changes TEXT,
          broadcast_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000),
          expires_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 300000)
        );`;

      // Convert a stored timestamp of unknown provenance to unix ms.
      const toUnixMs = (col: string): string => `
        CASE
          WHEN ${col} IS NULL THEN 0
          WHEN typeof(${col}) IN ('integer', 'real') THEN CAST(${col} AS INTEGER)
          WHEN CAST(${col} AS TEXT) GLOB '[0-9]*'
               AND CAST(${col} AS TEXT) NOT GLOB '*[A-Za-z: -]*'
            THEN CASE
                   WHEN LENGTH(CAST(${col} AS TEXT)) <= 10 THEN CAST(${col} AS INTEGER) * 1000
                   ELSE CAST(${col} AS INTEGER)
                 END
          ELSE COALESCE(CAST(strftime('%s', CAST(${col} AS TEXT)) AS INTEGER) * 1000, 0)
        END`;

      const agentIdSel = colTypes.has('agent_id') ? 'agent_id' : "''";
      const intentTypeSel = colTypes.has('intent_type') ? 'intent_type' : "''";
      const targetFilesSel = colTypes.has('target_files') ? `COALESCE(target_files, '[]')` : `'[]'`;
      const sessionSel = colTypes.has('session_id') ? 'session_id' : 'NULL';
      const descriptionSel = colTypes.has('description') ? 'description' : 'NULL';
      const expectedChangesSel = colTypes.has('expected_changes') ? 'expected_changes' : 'NULL';
      const broadcastSel = hasBroadcast ? toUnixMs('broadcast_at') : '0';

      const agentIdNotNull = colTypes.has('agent_id') ? ' AND agent_id IS NOT NULL' : '';
      const validIntentFilter = colTypes.has('intent_type')
        ? `intent_type IN ('read', 'write', 'refactor', 'delete')${agentIdNotNull}`
        : '1 = 0';

      const rebuild = (insertSql: string): void => {
        db.exec(canonicalDdl('pending_intents_new'));
        db.exec(insertSql);
        db.exec('DROP TABLE pending_intents;');
        db.exec('ALTER TABLE pending_intents_new RENAME TO pending_intents;');
        for (const idx of userIndexes) {
          try {
            db.exec(idx.sql);
          } catch {
            // index referenced a dropped column — intentionally skipped
          }
        }
        db.exec('CREATE INDEX IF NOT EXISTS idx_pending_intents_agent ON pending_intents(agent_id);');
        db.exec('CREATE INDEX IF NOT EXISTS idx_pending_intents_type ON pending_intents(intent_type);');
      };

      if (colTypes.has('timestamp') && colTypes.has('ttl_seconds') && !hasExpires) {
        rebuild(`
          INSERT INTO pending_intents_new
            (agent_id, intent_type, target_files, session_id, description, expected_changes, broadcast_at, expires_at)
          SELECT
            ${agentIdSel},
            ${intentTypeSel},
            ${targetFilesSel},
            ${sessionSel},
            ${descriptionSel},
            ${expectedChangesSel},
            COALESCE(CAST(timestamp AS INTEGER), 0) * 1000,
            CASE
              WHEN timestamp IS NULL OR ttl_seconds IS NULL THEN 0
              ELSE (CAST(timestamp AS INTEGER) + CAST(ttl_seconds AS INTEGER)) * 1000
            END
          FROM pending_intents
          WHERE ${validIntentFilter};
        `);
        return;
      }

      if (!hasExpires) {
        if (!hasBroadcast) {
          db.exec('ALTER TABLE pending_intents ADD COLUMN broadcast_at INTEGER NOT NULL DEFAULT 0;');
        }
        db.exec('ALTER TABLE pending_intents ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0;');
        return;
      }

      const expiresType = colTypes.get('expires_at') ?? '';
      const textValueWhere = hasBroadcast
        ? `typeof(expires_at) = 'text' OR typeof(broadcast_at) = 'text'`
        : `typeof(expires_at) = 'text'`;
      const textValueCount = db
        .prepare(`SELECT COUNT(*) AS n FROM pending_intents WHERE ${textValueWhere}`)
        .get() as { n: number };

      if (expiresType === 'INTEGER' && textValueCount.n === 0) {
        if (colTypes.has('timestamp')) {
          try {
            db.exec('DROP INDEX IF EXISTS idx_pending_intents_timestamp;');
            db.exec('ALTER TABLE pending_intents DROP COLUMN timestamp;');
          } catch {
            // older SQLite or a dependent schema object — column is harmless
          }
        }
        return; // already canonical — no-op.
      }

      if (expiresType === 'INTEGER') {
        if (!hasBroadcast) {
          db.exec('ALTER TABLE pending_intents ADD COLUMN broadcast_at INTEGER NOT NULL DEFAULT 0;');
        }
        const setClauses = [`expires_at = ${toUnixMs('expires_at')}`];
        setClauses.push(`broadcast_at = ${toUnixMs('broadcast_at')}`);
        db.exec(`
          UPDATE pending_intents
          SET ${setClauses.join(',\n              ')}
          WHERE ${textValueWhere};
        `);
        return;
      }

      // schema.ts shape with TEXT/datetime expires_at (or broadcast_at):
      // rebuild with INTEGER columns, converting every value to unix ms.
      rebuild(`
        INSERT INTO pending_intents_new
          (agent_id, intent_type, target_files, session_id, description, expected_changes, broadcast_at, expires_at)
        SELECT
          ${agentIdSel},
          ${intentTypeSel},
          ${targetFilesSel},
          ${sessionSel},
          ${descriptionSel},
          ${expectedChangesSel},
          ${broadcastSel},
          ${toUnixMs('expires_at')}
        FROM pending_intents
        WHERE ${validIntentFilter};
      `);
    },
    down: (db: DatabaseSync) => {
      // Best-effort revert to the migration-92 seconds-based shape.
      const tableExists = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pending_intents'")
        .get();
      if (!tableExists) return;
      db.exec(`
        CREATE TABLE IF NOT EXISTS pending_intents_old (
          id VARCHAR(36) PRIMARY KEY,
          agent_id VARCHAR(255) NOT NULL,
          intent_type VARCHAR(20) NOT NULL,
          target_files TEXT,
          expected_changes TEXT,
          timestamp INTEGER DEFAULT (strftime('%s', 'now')),
          ttl_seconds INTEGER DEFAULT 300
        );
        INSERT INTO pending_intents_old (id, agent_id, intent_type, target_files, expected_changes, timestamp, ttl_seconds)
        SELECT
          CAST(id AS TEXT),
          agent_id,
          intent_type,
          target_files,
          expected_changes,
          CAST(broadcast_at / 1000 AS INTEGER),
          CAST(max(0, expires_at - broadcast_at) / 1000 AS INTEGER)
        FROM pending_intents;
        DROP TABLE pending_intents;
        ALTER TABLE pending_intents_old RENAME TO pending_intents;
      `);
    },
  },
];
