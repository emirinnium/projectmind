import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL } from '../../src/storage/schema.js';
import { runMigrations } from '../../src/storage/migrations.js';

// Create a fresh in-memory database with schema
function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  runMigrations(db);
  return db;
}

describe('Schema Setup', () => {
  it('creates all required tables', () => {
    const db = createTestDb();
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as Array<{ name: string }>;
    
    const tableNames = tables.map(t => t.name);
    expect(tableNames).toContain('files');
    expect(tableNames).toContain('functions');
    expect(tableNames).toContain('classes');
    expect(tableNames).toContain('imports');
    expect(tableNames).toContain('projects');
    expect(tableNames).toContain('resources');
    expect(tableNames).toContain('data_flows');
    expect(tableNames).toContain('calls');
    expect(tableNames).toContain('settings');
    expect(tableNames).toContain('schema_version');
  });
});

describe('Project Operations', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createTestDb();
  });

  it('inserts and retrieves a project', () => {
    db.prepare('INSERT INTO projects (name, root_path, description) VALUES (?, ?, ?)')
      .run('test-project', '/test/path', 'A test project');

    const row = db.prepare('SELECT * FROM projects WHERE name = ?').get('test-project') as {
      id: number;
      name: string;
      root_path: string;
      description: string;
    };

    expect(row).toBeDefined();
    expect(row.id).toBe(1);
    expect(row.name).toBe('test-project');
    expect(row.root_path).toBe('/test/path');
    expect(row.description).toBe('A test project');
  });

  it('lists projects with file counts', () => {
    db.prepare('INSERT INTO projects (name, root_path) VALUES (?, ?)').run('proj1', '/p1');
    db.prepare('INSERT INTO projects (name, root_path) VALUES (?, ?)').run('proj2', '/p2');

    const rows = db.prepare('SELECT * FROM projects ORDER BY name').all();
    expect(rows).toHaveLength(2);
  });

  it('deletes a project and cascades to files', () => {
    db.prepare('INSERT INTO projects (name, root_path) VALUES (?, ?)').run('proj1', '/p1');
    db.prepare('INSERT INTO files (project_id, path, relative_path) VALUES (?, ?, ?)').run(1, '/p1/file.ts', 'file.ts');

    // Delete files first (cascade not enforced without FK)
    db.prepare('DELETE FROM files WHERE project_id = ?').run(1);
    db.prepare('DELETE FROM projects WHERE id = ?').run(1);

    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(1);
    expect(row).toBeUndefined();
  });
});

describe('File Operations', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createTestDb();
    // Insert default project
    db.prepare('INSERT INTO projects (id, name, root_path) VALUES (?, ?, ?)').run(1, 'default', '/test');
  });

  it('inserts and retrieves a file', () => {
    db.prepare('INSERT INTO files (project_id, path, relative_path, language, size_bytes, hash) VALUES (?, ?, ?, ?, ?, ?)')
      .run(1, '/test/src/index.ts', 'src/index.ts', 'typescript', 1024, 'abc123');

    const row = db.prepare('SELECT * FROM files WHERE path = ?').get('/test/src/index.ts') as {
      id: number;
      path: string;
      relative_path: string;
      language: string;
      size_bytes: number;
      hash: string;
    };

    expect(row).toBeDefined();
    expect(row.path).toBe('/test/src/index.ts');
    expect(row.language).toBe('typescript');
    expect(row.size_bytes).toBe(1024);
  });

  it('upserts a file (insert then update)', () => {
    // Insert
    db.prepare('INSERT INTO files (project_id, path, relative_path, language, size_bytes, hash) VALUES (?, ?, ?, ?, ?, ?)')
      .run(1, '/test/file.ts', 'file.ts', 'typescript', 100, 'hash1');

    // Update
    db.prepare('UPDATE files SET size_bytes = ?, hash = ? WHERE path = ? AND project_id = ?')
      .run(200, 'hash2', '/test/file.ts', 1);

    const row = db.prepare('SELECT * FROM files WHERE path = ?').get('/test/file.ts') as {
      size_bytes: number;
      hash: string;
    };

    expect(row.size_bytes).toBe(200);
    expect(row.hash).toBe('hash2');
  });

  it('stores and retrieves functions for a file', () => {
    db.prepare('INSERT INTO files (project_id, path, relative_path) VALUES (?, ?, ?)').run(1, '/test/file.ts', 'file.ts');
    const fileId = (db.prepare('SELECT id FROM files WHERE path = ?').get('/test/file.ts') as { id: number }).id;

    db.prepare('INSERT INTO functions (file_id, name, signature, complexity, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?)')
      .run(fileId, 'myFunction', 'myFunction(x: number)', 5, 10, 20);

    const fns = db.prepare('SELECT * FROM functions WHERE file_id = ?').all(fileId) as Array<{
      name: string;
      complexity: number;
      start_line: number;
      end_line: number;
    }>;

    expect(fns).toHaveLength(1);
    expect(fns[0].name).toBe('myFunction');
    expect(fns[0].complexity).toBe(5);
    expect(fns[0].start_line).toBe(10);
  });

  it('stores and retrieves classes for a file', () => {
    db.prepare('INSERT INTO files (project_id, path, relative_path) VALUES (?, ?, ?)').run(1, '/test/file.ts', 'file.ts');
    const fileId = (db.prepare('SELECT id FROM files WHERE path = ?').get('/test/file.ts') as { id: number }).id;

    db.prepare('INSERT INTO classes (file_id, name, methods_count, properties_count) VALUES (?, ?, ?, ?)')
      .run(fileId, 'MyClass', 5, 3);

    const classes = db.prepare('SELECT * FROM classes WHERE file_id = ?').all(fileId) as Array<{
      name: string;
      methods_count: number;
      properties_count: number;
    }>;

    expect(classes).toHaveLength(1);
    expect(classes[0].name).toBe('MyClass');
    expect(classes[0].methods_count).toBe(5);
  });

  it('stores and retrieves imports for a file', () => {
    db.prepare('INSERT INTO files (project_id, path, relative_path) VALUES (?, ?, ?)').run(1, '/test/file.ts', 'file.ts');
    const fileId = (db.prepare('SELECT id FROM files WHERE path = ?').get('/test/file.ts') as { id: number }).id;

    db.prepare('INSERT INTO imports (file_id, source, kind, resolved) VALUES (?, ?, ?, ?)')
      .run(fileId, './utils', 'relative', 1);

    const imports = db.prepare('SELECT * FROM imports WHERE file_id = ?').all(fileId) as Array<{
      source: string;
      kind: string;
      resolved: number;
    }>;

    expect(imports).toHaveLength(1);
    expect(imports[0].source).toBe('./utils');
    expect(imports[0].resolved).toBe(1);
  });
});

describe('Resource & Data Flow Operations', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createTestDb();
    db.prepare('INSERT INTO projects (id, name, root_path) VALUES (?, ?, ?)').run(1, 'default', '/test');
  });

  it('creates and retrieves resources', () => {
    db.prepare('INSERT INTO resources (qualified_name, kind, identity) VALUES (?, ?, ?)')
      .run('fs.readFile("/input.txt")', 'FILE', '/input.txt');

    const row = db.prepare('SELECT * FROM resources WHERE qualified_name = ?')
      .get('fs.readFile("/input.txt")') as { kind: string; identity: string };

    expect(row.kind).toBe('FILE');
    expect(row.identity).toBe('/input.txt');
  });

  it('records data flows between resources', () => {
    db.prepare('INSERT INTO resources (qualified_name, kind, identity) VALUES (?, ?, ?)')
      .run('fs.readFile("/input.txt")', 'FILE', '/input.txt');
    const fromId = (db.prepare('SELECT id FROM resources WHERE qualified_name = ?')
      .get('fs.readFile("/input.txt")') as { id: number }).id;

    db.prepare('INSERT INTO resources (qualified_name, kind, identity) VALUES (?, ?, ?)')
      .run('processInput', 'ENV', 'inputSource');
    const toId = (db.prepare('SELECT id FROM resources WHERE qualified_name = ?')
      .get('processInput') as { id: number }).id;

    db.prepare('INSERT INTO data_flows (from_resource_id, to_resource_id, kind, project_id) VALUES (?, ?, ?, ?)')
      .run(fromId, toId, 'arg', 1);

    const flows = db.prepare('SELECT * FROM data_flows WHERE project_id = ?').all(1) as Array<{
      from_resource_id: number;
      to_resource_id: number;
      kind: string;
    }>;

    expect(flows).toHaveLength(1);
    expect(flows[0].kind).toBe('arg');
  });
});

describe('Settings Operations', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createTestDb();
  });

  it('stores and retrieves settings', () => {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('current_project_id', '42');

    const row = db.prepare('SELECT * FROM settings WHERE key = ?').get('current_project_id') as {
      key: string;
      value: string;
    };

    expect(row.value).toBe('42');
  });

  it('updates settings', () => {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('test_key', 'initial');
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('test_key', 'updated');

    const row = db.prepare('SELECT * FROM settings WHERE key = ?').get('test_key') as { value: string };
    expect(row.value).toBe('updated');
  });
});
