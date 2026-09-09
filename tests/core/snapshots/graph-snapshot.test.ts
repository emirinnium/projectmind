import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { KnowledgeGraph } from '../../../src/storage/knowledge-graph.js';
import { SCHEMA_SQL } from '../../../src/storage/schema.js';
import {
  createGraphSnapshot,
  calculateGraphSnapshotHash,
  diffGraphSnapshots,
  readGraphSnapshot,
  verifyGraphSnapshot,
  writeGraphSnapshot,
  type GraphSnapshot,
} from '../../../src/core/snapshots/graph-snapshot.js';

const directories: string[] = [];

function createGraph(): { db: DatabaseSync; graph: KnowledgeGraph } {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA_SQL);
  db.prepare('INSERT INTO projects (id, name, root_path) VALUES (?, ?, ?)').run(
    1,
    'fixture',
    '/tmp/fixture',
  );
  db.prepare(
    `INSERT INTO files (id, project_id, path, relative_path, language, size_bytes, hash, cognitive_load)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(1, 1, '/tmp/fixture/src/a.ts', 'src/a.ts', 'typescript', 20, 'hash-a', 0.2);
  db.prepare(
    `INSERT INTO files (id, project_id, path, relative_path, language, size_bytes, hash, cognitive_load)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(2, 1, '/tmp/fixture/src/b.ts', 'src/b.ts', 'typescript', 30, 'hash-b', 0.3);
  db.prepare(
    'INSERT INTO imports (file_id, source, kind, resolved, resolved_path) VALUES (?, ?, ?, ?, ?)',
  ).run(1, './b.js', 'import', 1, 'src/b.ts');
  db.prepare(
    'INSERT INTO functions (id, file_id, name, signature, complexity) VALUES (?, ?, ?, ?, ?)',
  ).run(1, 1, 'run', 'run()', 1);
  db.prepare(
    'INSERT INTO functions (id, file_id, name, signature, complexity) VALUES (?, ?, ?, ?, ?)',
  ).run(2, 2, 'finish', 'finish()', 1);
  db.prepare(
    `INSERT INTO calls
       (from_function_id, to_function_id, dynamic, static_missed, call_count, workload_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(1, 2, 1, 0, 3, 'smoke');
  const graph = {
    db,
    getCurrentProject: () => ({ id: 1, name: 'fixture', rootPath: '/tmp/fixture' }),
    getCurrentProjectId: () => 1,
    getAllFiles: () => [
      {
        relativePath: 'src/b.ts',
        path: '/tmp/fixture/src/b.ts',
        language: 'typescript',
        sizeBytes: 30,
        hash: 'hash-b',
        cognitiveLoad: 0.3,
      },
      {
        relativePath: 'src/a.ts',
        path: '/tmp/fixture/src/a.ts',
        language: 'typescript',
        sizeBytes: 20,
        hash: 'hash-a',
        cognitiveLoad: 0.2,
      },
    ],
  } as unknown as KnowledgeGraph;
  return { db, graph };
}

afterEach(async () => {
  while (directories.length > 0) {
    const path = directories.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe('graph snapshots', () => {
  it('creates a portable deterministic snapshot including imports and calls', () => {
    const { db, graph } = createGraph();
    try {
      const snapshot = createGraphSnapshot(graph);
      expect(snapshot.files.map((file) => file.path)).toEqual(['src/a.ts', 'src/b.ts']);
      expect(snapshot.imports[0]).toMatchObject({
        fromPath: 'src/a.ts',
        resolvedPath: 'src/b.ts',
        resolved: true,
      });
      expect(snapshot.calls[0]).toMatchObject({
        fromPath: 'src/a.ts',
        toPath: 'src/b.ts',
        callCount: 3,
        workloadId: 'smoke',
      });
      const second = createGraphSnapshot(graph);
      expect(second.graphHash).toBe(snapshot.graphHash);
    } finally {
      db.close();
    }
  });

  it('keeps hashes deterministic when entries share a primary identity prefix', () => {
    const { db, graph } = createGraph();
    try {
      const baseline = createGraphSnapshot(graph);
      const importEntry = baseline.imports[0];
      const callEntry = baseline.calls[0];
      const left = {
        ...baseline,
        imports: [importEntry, { ...importEntry, resolved: false }],
        calls: [callEntry, { ...callEntry, dynamic: false, callCount: 4 }],
      };
      const right = {
        ...left,
        imports: [...left.imports].reverse(),
        calls: [...left.calls].reverse(),
      };

      expect(calculateGraphSnapshotHash(left)).toBe(calculateGraphSnapshotHash(right));
    } finally {
      db.close();
    }
  });

  it('writes, reads, and rejects tampered snapshots without leaving the project', async () => {
    const root = await mkdtemp(join(tmpdir(), 'projectmind-snapshot-'));
    directories.push(root);
    const { db, graph } = createGraph();
    try {
      const written = await writeGraphSnapshot(graph, root, 'snapshots/graph.json');
      expect(written.path).toBe(join(root, 'snapshots', 'graph.json'));
      const read = await readGraphSnapshot(written.path);
      expect(read.graphHash).toBe(written.snapshot.graphHash);
      const raw = await readFile(written.path, 'utf8');
      expect(raw.endsWith('\n')).toBe(true);
      await expect(writeGraphSnapshot(graph, root, '../outside.json')).rejects.toThrow(
        'escapes the project root',
      );
    } finally {
      db.close();
    }
  });

  it('explains graph drift and snapshot-to-snapshot changes', () => {
    const { db, graph } = createGraph();
    try {
      const baseline = createGraphSnapshot(graph);
      const changed: GraphSnapshot = {
        ...baseline,
        files: [
          ...baseline.files.filter((file) => file.path !== 'src/b.ts'),
          {
            path: 'src/c.ts',
            language: 'typescript',
            sizeBytes: 10,
            hash: 'hash-c',
            cognitiveLoad: 0.1,
          },
        ],
        imports: [],
        calls: [],
      };
      const diff = diffGraphSnapshots(baseline, changed);
      expect(diff.addedFiles).toEqual(['src/c.ts']);
      expect(diff.removedFiles).toEqual(['src/b.ts']);
      expect(diff.removedImports).toHaveLength(1);
      expect(diff.removedCalls).toHaveLength(1);
      const verification = verifyGraphSnapshot(changed, graph);
      expect(verification.match).toBe(false);
      expect(verification.currentHash).toBe(baseline.graphHash);
      expect(verification.limitations.length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });
});
