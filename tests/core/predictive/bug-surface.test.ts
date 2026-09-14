import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createIsolatedDatabase } from '../../test-helpers/database.js';
import { buildBugSurfaceReport } from '../../../src/core/predictive/bug-surface.js';
import type { FileInfo } from '../../../src/storage/kg/types.js';

function file(path: string, id: number): FileInfo {
  return {
    id,
    path,
    relativePath: path.split('/').slice(-2).join('/'),
    language: 'typescript',
    sizeBytes: 100,
    hash: 'hash',
    agentTouched: false,
    agentTouchedBy: null,
    agentTouchedAt: null,
    cognitiveLoad: 0,
    lastScanned: new Date().toISOString(),
    lastSynced: new Date().toISOString(),
    patterns: [],
  };
}

describe('predictive bug surface', () => {
  it('ranks measured failures, debt, complexity, and dependents with limitations', async () => {
    const isolated = createIsolatedDatabase();
    const root = await mkdtemp(join(tmpdir(), 'projectmind-bug-surface-'));
    try {
      const hotPath = join(root, 'src', 'hot.ts').replace(/\\/g, '/');
      await mkdir(join(root, 'src'));
      await writeFile(join(root, 'src', 'hot.ts'), 'export const hot = true;\n', 'utf8');
      const hot = file(hotPath, 1);
      isolated.db
        .prepare('INSERT INTO projects (id, name, root_path) VALUES (?, ?, ?)')
        .run(1, 'bug-surface-test', root);
      isolated.db
        .prepare(
          `INSERT INTO files (id, project_id, path, relative_path, language, size_bytes, hash)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(1, 1, hot.path, hot.relativePath, hot.language, hot.sizeBytes, hot.hash);
      isolated.db
        .prepare(
          'INSERT INTO debt_items (file_id, type, description, severity, project_id) VALUES (?, ?, ?, ?, ?)',
        )
        .run(1, 'complexity', 'hot', 'high', 1);
      isolated.db
        .prepare(
          'INSERT INTO test_failure_log (prediction_id, file_path, failure_occurred) VALUES (?, ?, ?)',
        )
        .run('p1', hotPath, 1);
      isolated.db
        .prepare(
          'INSERT INTO test_failure_log (prediction_id, file_path, failure_occurred) VALUES (?, ?, ?)',
        )
        .run('p2', hotPath, 0);
      const report = buildBugSurfaceReport(
        isolated.db,
        {
          getAllFiles: () => [hot],
          getDependents: () => [hot],
          getFunctions: () => [
            { id: 1, name: 'hot', signature: '', complexity: 15, startLine: 1, endLine: 1 },
          ],
          getCurrentProjectId: () => 1,
        },
        root,
      );
      expect(report.items[0]).toMatchObject({
        path: 'src/hot.ts',
        riskLevel: expect.stringMatching(/low|medium|high|critical/),
        signals: expect.objectContaining({ historicalFailures: 1, historicalObservations: 2 }),
      });
      expect(report.items[0]?.evidence.join(' ')).toMatch(
        /historical outcome|direct dependent|debt/i,
      );
      expect(report.limitations.join(' ')).toMatch(/not a calibrated probability/i);
    } finally {
      isolated.cleanup();
      await rm(root, { recursive: true, force: true });
    }
  });
});
