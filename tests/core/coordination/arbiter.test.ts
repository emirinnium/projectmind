import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { initDatabase, closeDatabase } from '../../../src/storage/database.js';
import { KnowledgeGraph } from '../../../src/storage/kg/graph.js';
import { arbitrateAgents } from '../../../src/core/coordination/arbiter.js';

function seedGraph(db: DatabaseSync): void {
  const insertFile = db.prepare(
    'INSERT INTO files (project_id, path, relative_path, language, size_bytes, hash) VALUES (?, ?, ?, ?, ?, ?)',
  );
  insertFile.run(1, '/arbiter/shared.ts', 'shared.ts', 'typescript', 10, 'hash-shared');
  insertFile.run(1, '/arbiter/consumer.ts', 'consumer.ts', 'typescript', 10, 'hash-consumer');
  insertFile.run(
    1,
    '/arbiter/independent.ts',
    'independent.ts',
    'typescript',
    10,
    'hash-independent',
  );

  const fileId = (relativePath: string): number =>
    (db.prepare('SELECT id FROM files WHERE relative_path = ?').get(relativePath) as { id: number })
      .id;
  db.prepare(
    'INSERT INTO imports (file_id, source, kind, resolved, resolved_path) VALUES (?, ?, ?, ?, ?)',
  ).run(fileId('consumer.ts'), './shared', 'relative', 1, 'shared.ts');
}

describe('multi-agent arbiter', () => {
  let db: DatabaseSync;
  let kg: KnowledgeGraph;

  beforeAll(() => {
    db = initDatabase(':memory:');
    kg = new KnowledgeGraph(db);
    seedGraph(db);
  });

  afterAll(() => closeDatabase());

  it('combines collision evidence, dependency order, groups, and file shards', () => {
    const report = arbitrateAgents(kg, {
      agents: [
        { agentName: 'consumer-agent', files: ['consumer.ts', 'independent.ts'] },
        { agentName: 'shared-agent', files: ['shared.ts'] },
      ],
    });

    expect(report.version).toBe('projectmind-arbiter-v1');
    expect(report.agents).toEqual(['consumer-agent', 'shared-agent']);
    expect(report.pairRisks).toHaveLength(1);
    expect(report.pairRisks[0]?.level).toBe('medium');
    expect(report.dependencyEdges).toEqual([
      expect.objectContaining({
        before: 'shared-agent',
        after: 'consumer-agent',
        sourceFiles: ['consumer.ts'],
        targetFiles: ['shared.ts'],
      }),
    ]);
    expect(report.recommendedRebaseOrder).toEqual(['shared-agent', 'consumer-agent']);
    expect(report.conflictGroups[0]?.agents).toEqual(['consumer-agent', 'shared-agent']);
    expect(report.shardSuggestions[0]).toMatchObject({
      agentName: 'consumer-agent',
      isolatedFiles: ['independent.ts'],
      coordinationFiles: ['consumer.ts'],
    });
  });

  it('surfaces a lock held by an agent outside the request', () => {
    const acquired = kg.acquireFileLock('consumer.ts', 'unlisted-agent', {
      ttlMinutes: 30,
      reason: 'external work',
    });
    expect(acquired.status).toBe('acquired');

    const report = arbitrateAgents(kg, {
      agents: [
        { agentName: 'agent-a', files: ['consumer.ts'] },
        { agentName: 'agent-b', files: ['independent.ts'] },
      ],
    });

    expect(report.unplannedLocks).toEqual([
      expect.objectContaining({ filePath: 'consumer.ts', heldBy: 'unlisted-agent' }),
    ]);
    expect(report.agentRisks[0]).toMatchObject({ agentName: 'agent-a', level: 'high' });

    expect(kg.releaseFileLock('./consumer.ts', 'unlisted-agent').status).toBe('released');
  });

  it('rejects duplicate agent names instead of merging their plans silently', () => {
    expect(() =>
      arbitrateAgents(kg, {
        agents: [
          { agentName: 'same', files: ['consumer.ts'] },
          { agentName: 'same', files: ['shared.ts'] },
        ],
      }),
    ).toThrow('Duplicate agentName: same');
  });
});
