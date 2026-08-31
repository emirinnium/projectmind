import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL } from '../../src/storage/schema.js';
import { runMigrations } from '../../src/storage/migrations.js';
import { MemoryRepository } from '../../src/storage/repositories/memory-repository.js';
function createTestDb() {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(SCHEMA_SQL);
    runMigrations(db);
    return db;
}
describe('MemoryRepository', () => {
    let db;
    let repo;
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
        it('reports merge status on store (stored/merged/conflict)', () => {
            // Fresh key → insert
            const inserted = repo.storeTeamMemory({
                agentName: 'agent-a',
                scope: 'docs',
                key: 'spec',
                value: 'a\nb\nc',
                isPublic: true,
            });
            expect(inserted.status).toBe('stored');
            // Stale local (no recorded ancestor) → fast-forward
            const fast = repo.storeTeamMemory({
                agentName: 'agent-b',
                scope: 'docs',
                key: 'spec',
                value: 'A\nb\nc',
                isPublic: true,
            });
            expect(fast.status).toBe('stored');
            expect(fast.nextBaseValue).toBe('a\nb\nc');
            // Both sides diverged from base in DISJOINT regions → clean 3-way merge
            const merged = repo.storeTeamMemory({
                agentName: 'agent-c',
                scope: 'docs',
                key: 'spec',
                value: 'a\nB\nc',
                isPublic: true,
            });
            expect(merged.status).toBe('merged');
            expect(merged.storedValue).toBe('A\nB\nc');
            expect(merged.nextBaseValue).toBe('A\nb\nc');
            // Overlapping conflicting change → kept stored value, no write
            const conflict = repo.storeTeamMemory({
                agentName: 'agent-d',
                scope: 'docs',
                key: 'spec',
                value: 'a\nZ\nc',
                isPublic: true,
            });
            expect(conflict.status).toBe('conflict');
            expect(conflict.storedValue).toBe('A\nB\nc');
            expect(conflict.conflicts.length).toBeGreaterThan(0);
            const stored = repo.getTeamMemories({ scope: 'docs', agentName: 'agent-a' });
            expect(stored).toHaveLength(1);
            expect(stored[0].value).toBe('A\nB\nc');
            expect(stored[0].baseValue).toBe('A\nb\nc');
        });
    });
    describe('team memory migration', () => {
        it('adds base_value column for databases created before v8', () => {
            const db = new DatabaseSync(':memory:');
            // Simulate a v7-era database: team_memories WITHOUT base_value.
            db.exec(`CREATE TABLE team_memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_name TEXT NOT NULL,
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        is_public BOOLEAN DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(scope, key)
      )`);
            db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );`);
            db.prepare('INSERT INTO schema_version (version, name) VALUES (?, ?)').run(7, 'test-v7');
            runMigrations(db);
            const cols = db.prepare('PRAGMA table_info(team_memories)').all();
            expect(cols.some((c) => c.name === 'base_value')).toBe(true);
            db.close();
        });
    });
});
//# sourceMappingURL=memory-repository.test.js.map