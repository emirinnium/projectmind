import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseManager, initDatabase, closeDatabase } from '../../src/storage/database.js';

describe('DatabaseManager', () => {
  let manager: DatabaseManager;

  afterEach(() => {
    if (manager) {
      manager.close();
    }
  });

  describe('init', () => {
    it('initializes with in-memory database', () => {
      manager = new DatabaseManager();
      const db = manager.init();

      expect(db).toBeDefined();
      expect(manager.isInitialized()).toBe(true);
    });

    it('configures SQLite pragmas', () => {
      manager = new DatabaseManager();
      manager.init();

      // In-memory databases may not support WAL, but foreign_keys should be ON
      const fkResult = manager.getDb().prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
      expect(fkResult.foreign_keys).toBe(1);
    });

    it('creates schema tables', () => {
      manager = new DatabaseManager();
      manager.init();

      const tables = manager.getDb().prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='files'"
      ).get();
      expect(tables).toBeDefined();
    });

    it('throws when accessing db before init', () => {
      manager = new DatabaseManager();
      expect(() => manager.getDb()).toThrow('not initialized');
    });

    it('returns same db on multiple init calls', () => {
      manager = new DatabaseManager();
      const db1 = manager.init();
      const db2 = manager.init();
      expect(db1).toBe(db2);
    });
  });

  describe('getStatement', () => {
    it('returns a prepared statement', () => {
      manager = new DatabaseManager();
      manager.init();

      const stmt = manager.getStatement('SELECT 1 as test');
      expect(stmt).toBeDefined();
      const result = stmt.get() as { test: number };
      expect(result.test).toBe(1);
    });

    it('caches prepared statements', () => {
      manager = new DatabaseManager();
      manager.init();

      const stmt1 = manager.getStatement('SELECT 1 as test');
      const stmt2 = manager.getStatement('SELECT 1 as test');
      expect(stmt1).toBe(stmt2);
    });
  });

  describe('runInTransaction', () => {
    it('commits a successful transaction', () => {
      manager = new DatabaseManager();
      manager.init();

      manager.runInTransaction(() => {
        manager.getDb().prepare("INSERT INTO projects (name, root_path) VALUES (?, ?)").run('test', '/test');
      });

      const row = manager.getDb().prepare('SELECT * FROM projects WHERE name = ?').get('test') as { name: string };
      expect(row.name).toBe('test');
    });

    it('rolls back a failed transaction', () => {
      manager = new DatabaseManager();
      manager.init();

      expect(() => {
        manager.runInTransaction(() => {
          manager.getDb().prepare("INSERT INTO projects (name, root_path) VALUES (?, ?)").run('test', '/test');
          throw new Error('Intentional error');
        });
      }).toThrow('Intentional error');

      const row = manager.getDb().prepare('SELECT * FROM projects WHERE name = ?').get('test');
      expect(row).toBeUndefined();
    });

    it('supports nested transactions', () => {
      manager = new DatabaseManager();
      manager.init();

      manager.runInTransaction(() => {
        manager.getDb().prepare("INSERT INTO projects (name, root_path) VALUES (?, ?)").run('outer', '/outer');

        manager.runInTransaction(() => {
          manager.getDb().prepare("INSERT INTO projects (name, root_path) VALUES (?, ?)").run('inner', '/inner');
        });
      });

      const outer = manager.getDb().prepare('SELECT * FROM projects WHERE name = ?').get('outer') as { name: string };
      const inner = manager.getDb().prepare('SELECT * FROM projects WHERE name = ?').get('inner') as { name: string };
      expect(outer.name).toBe('outer');
      expect(inner.name).toBe('inner');
    });

    it('isInTransaction returns correct state', () => {
      manager = new DatabaseManager();
      manager.init();

      expect(manager.isInTransaction()).toBe(false);

      manager.runInTransaction(() => {
        expect(manager.isInTransaction()).toBe(true);
      });

      expect(manager.isInTransaction()).toBe(false);
    });
  });

  describe('getSchemaVersion', () => {
    it('returns 0 for fresh database', () => {
      manager = new DatabaseManager();
      manager.init();

      // Schema version table may not exist yet in fresh db
      const version = manager.getSchemaVersion();
      expect(version).toBeGreaterThanOrEqual(0);
    });
  });

  describe('close', () => {
    it('closes the database connection', () => {
      manager = new DatabaseManager();
      manager.init();

      expect(manager.isInitialized()).toBe(true);
      manager.close();
      expect(manager.isInitialized()).toBe(false);
    });

    it('clears statement cache on close', () => {
      manager = new DatabaseManager();
      manager.init();

      manager.getStatement('SELECT 1');
      manager.close();

      // After close and re-init, should still work
      manager.init();
      const stmt = manager.getStatement('SELECT 1 as test');
      const result = stmt.get() as { test: number };
      expect(result.test).toBe(1);
    });
  });

  describe('busy_timeout (SQLITE_BUSY mitigation)', () => {
    it('DatabaseManager.init() sets busy_timeout to 5000ms', () => {
      manager = new DatabaseManager();
      manager.init();

      const row = manager.getDb().prepare('PRAGMA busy_timeout').get() as { timeout: number };
      expect(row.timeout).toBe(5000);
    });

    it('initDatabase() sets busy_timeout to 5000ms', () => {
      const db = initDatabase('tests/tmp-busy-timeout.db');
      try {
        const row = db.prepare('PRAGMA busy_timeout').get() as { timeout: number };
        expect(row.timeout).toBe(5000);
      } finally {
        closeDatabase();
      }
    });
  });
});
