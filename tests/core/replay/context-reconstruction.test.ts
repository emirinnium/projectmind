import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentReplayStore } from '@/core/replay/agent-replay.js';
import { reconstructContext } from '@/core/replay/context-reconstruction.js';
import { stableHash } from '@/utils/hash.js';

describe('context reconstruction', () => {
  it('reconstructs hash-matching recorded files and returns source only on request', () => {
    const root = mkdtempSync(join(tmpdir(), 'projectmind-context-replay-'));
    mkdirSync(join(root, 'src'));
    const content = 'export const answer = 42;\n';
    writeFileSync(join(root, 'src', 'answer.ts'), content, 'utf8');
    const db = new DatabaseSync(':memory:');
    const event = new AgentReplayStore(db, 1).append({
      eventType: 'context',
      toolName: 'get_context',
      outcome: {
        selectedPaths: JSON.stringify(['src/answer.ts']),
        selectedSourceHashes: JSON.stringify({ 'src/answer.ts': stableHash(content) }),
      },
    });

    const metadataOnly = reconstructContext(root, event);
    expect(metadataOnly).toMatchObject({ status: 'recorded' });
    expect(metadataOnly.files[0]?.content).toBeUndefined();
    const withSource = reconstructContext(root, event, true);
    expect(withSource.files[0]).toMatchObject({
      path: 'src/answer.ts',
      status: 'recorded',
      content,
    });
    db.close();
  });

  it('distinguishes source drift from unavailable/ignored files', () => {
    const root = mkdtempSync(join(tmpdir(), 'projectmind-context-replay-state-'));
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'generated'));
    writeFileSync(join(root, 'src', 'answer.ts'), 'export const answer = 42;\n', 'utf8');
    writeFileSync(join(root, 'generated', 'output.ts'), 'export const generated = true;\n', 'utf8');
    writeFileSync(join(root, '.pmignore'), 'generated/\n', 'utf8');
    const db = new DatabaseSync(':memory:');
    const event = new AgentReplayStore(db, 1).append({
      eventType: 'context',
      toolName: 'get_context',
      outcome: {
        selectedPaths: JSON.stringify(['src/answer.ts', 'generated/output.ts']),
        selectedSourceHashes: JSON.stringify({
          'src/answer.ts': 'a'.repeat(64),
          'generated/output.ts': stableHash('export const generated = true;\n'),
        }),
      },
    });

    const result = reconstructContext(root, event);
    expect(result.status).toBe('diverged');
    expect(result.files.find((file) => file.path === 'src/answer.ts')?.status).toBe('diverged');
    expect(result.files.find((file) => file.path === 'generated/output.ts')?.status).toBe(
      'unavailable',
    );
    db.close();
  });

  it('rejects legacy events without a context snapshot instead of guessing', () => {
    const result = reconstructContext('C:/project', {
      eventType: 'context',
      outcome: { selectedFileCount: 1 },
    });
    expect(result).toEqual({
      status: 'unavailable',
      files: [],
      reason: 'The event predates context snapshots or its snapshot metadata is malformed.',
    });
  });
});
