import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { initDatabase, setDatabase, closeDatabase } from '../src/storage/database.js';
import { SCHEMA_SQL } from '../src/storage/schema.js';
import { KnowledgeGraph } from '../src/storage/knowledge-graph.js';
import { parseFile } from '../src/parser/ast-parser.js';
import { TaintAnalyzer } from '../src/parser/taint-analyzer.js';

const TEST_DB = join(process.cwd(), 'tests', `tmp-vitest-${Date.now()}.db`);
const PROJECT_ROOT = join(process.cwd());
const SRC_DIR = join(PROJECT_ROOT, 'src');

beforeAll(async () => {
  const dbDir = dirname(TEST_DB);
  if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });
  for (let i = 0; i < 5; i++) {
    try {
      if (existsSync(TEST_DB)) rmSync(TEST_DB);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
});

afterAll(async () => {
  // F44: close the last open connection first — on Windows an open SQLite
  // handle locks the file and rmSync below would silently fail.
  try {
    closeDatabase();
  } catch {
    // already closed
  }
  for (let i = 0; i < 5; i++) {
    try {
      if (existsSync(TEST_DB)) rmSync(TEST_DB);
      if (existsSync(TEST_DB + '-shm')) rmSync(TEST_DB + '-shm');
      if (existsSync(TEST_DB + '-wal')) rmSync(TEST_DB + '-wal');
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
});

describe('Database', () => {
  it('initializes and runs migrations', () => {
    const db = initDatabase(TEST_DB);
    db.exec(SCHEMA_SQL);
    setDatabase(db);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    expect(tables.some((t) => t.name === 'files')).toBe(true);
  });
});

describe('Knowledge Graph', () => {
  it('creates projects and switches context', () => {
    const db = initDatabase(TEST_DB);
    db.exec(SCHEMA_SQL);
    setDatabase(db);
    const kg = new KnowledgeGraph(db);

    const project = kg.createProject('vitest-project', PROJECT_ROOT, 'Vitest project');
    expect(project.id).toBeGreaterThan(0);
    expect(project.name).toBe('vitest-project');

    const switchResult = kg.switchProject(project.id);
    expect(switchResult.success).toBe(true);
    expect(switchResult.project?.id).toBe(project.id);

    const current = kg.getCurrentProject();
    expect(current?.id).toBe(project.id);
  });
});

describe('Taint Analyzer', () => {
  it('detects taint flows from file source to exec sink', () => {
    const db = initDatabase(TEST_DB);
    db.exec(SCHEMA_SQL);
    setDatabase(db);
    const kg = new KnowledgeGraph(db);
    const analyzer = new TaintAnalyzer(kg);

    const content = `import fs from 'fs';
function processInput() {
  const data = fs.readFileSync('./input.txt');
  exec(data);
}`;

    const flows = analyzer.analyzeSource('test.ts', content, 'typescript');
    expect(flows.length).toBeGreaterThanOrEqual(1);
    expect(flows.some((f) => f.source.kind === 'FILE' && f.sink.qualifiedName === 'exec')).toBe(true);
  });
});
