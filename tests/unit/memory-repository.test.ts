import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL } from '../../src/storage/schema.js';
import { runMigrations } from '../../src/storage/migrations.js';
import { MemoryRepository } from '../../src/storage/repositories/memory-repository.js';

function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  runMigrations(db);
  return db;
}

describe('MemoryRepository', () => {
  let db: DatabaseSync;
  let repo: MemoryRepository;

  beforeEach(() => {
    db = createTestDb();
    db.prepare('INSERT INTO projects (id, name, root_path) VALUES (?, ?, ?)').run(1, 'default', '/test');
    repo = new MemoryRepository(db);
  });

  describe('sessions', () => {
    it('starts and ends a session', () => {
      const sessionId = repo.startSession('test-agent');
      expect(sessionId).toBe(1);

      repo.endSession(sessionId);

      const sessions = repo.getSessions('test-agent');
      expect(sessions).toHaveLength(1);
      expect(sessions[0].agentName).toBe('test-agent');
      expect(sessions[0].endedAt).not.toBeNull();
    });

    it('lists sessions by agent name', () => {
      repo.startSession('agent-a');
      repo.startSession('agent-b');

      const agentASessions = repo.getSessions('agent-a');
      expect(agentASessions).toHaveLength(1);
      expect(agentASessions[0].agentName).toBe('agent-a');
    });

    it('lists all sessions when no agent specified', () => {
      repo.startSession('agent-a');
      repo.startSession('agent-b');

      const allSessions = repo.getSessions();
      expect(allSessions).toHaveLength(2);
    });
  });

  describe('memory', () => {
    it('stores and retrieves memory', () => {
      const sessionId = repo.startSession('test-agent');
      repo.storeMemory(sessionId, 'decisions', 'file-1', JSON.stringify({ decision: 'refactor', reasoning: 'too complex' }));

      const memories = repo.getMemory('decisions', 'file-1');
      expect(memories).toHaveLength(1);
      expect(memories[0].value).toEqual({ decision: 'refactor', reasoning: 'too complex' });
    });

    it('retrieves all memories for a scope', () => {
      const sessionId = repo.startSession('test-agent');
      repo.storeMemory(sessionId, 'decisions', 'file-1', 'decision-1');
      repo.storeMemory(sessionId, 'decisions', 'file-2', 'decision-2');

      const memories = repo.getMemory('decisions');
      expect(memories).toHaveLength(2);
    });

    it('returns empty array for non-existent scope', () => {
      const memories = repo.getMemory('nonexistent');
      expect(memories).toHaveLength(0);
    });
  });

  describe('team memory', () => {
    it('stores and retrieves team memory', () => {
      repo.storeTeamMemory({
        agentName: 'agent-a',
        scope: 'architecture',
        key: 'pattern-1',
        value: 'Use Repository Pattern',
        isPublic: true,
      });

      const memories = repo.getTeamMemories({ scope: 'architecture', agentName: 'agent-a' });
      expect(memories).toHaveLength(1);
      expect(memories[0].value).toBe('Use Repository Pattern');
      expect(memories[0].isPublic).toBe(true);
    });

    it('updates existing team memory', () => {
      repo.storeTeamMemory({
        agentName: 'agent-a',
        scope: 'patterns',
        key: 'rule-1',
        value: 'initial',
        isPublic: true,
      });

      repo.storeTeamMemory({
        agentName: 'agent-b',
        scope: 'patterns',
        key: 'rule-1',
        value: 'updated',
        isPublic: true,
      });

      const memories = repo.getTeamMemories({ scope: 'patterns', agentName: 'agent-a' });
      expect(memories).toHaveLength(1);
      expect(memories[0].value).toBe('updated');
    });

    it('returns private memories only for owning agent', () => {
      repo.storeTeamMemory({
        agentName: 'agent-a',
        scope: 'secrets',
        key: 'private-key',
        value: 'secret-value',
        isPublic: false,
      });

      const agentAMemories = repo.getTeamMemories({ scope: 'secrets', agentName: 'agent-a' });
      expect(agentAMemories).toHaveLength(1);

      const agentBMemories = repo.getTeamMemories({ scope: 'secrets', agentName: 'agent-b' });
      expect(agentBMemories).toHaveLength(0);
    });
  });
});
