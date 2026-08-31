import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL } from '../../src/storage/schema.js';
import { runMigrations } from '../../src/storage/migrations.js';
import { DataFlowRepository } from '../../src/storage/repositories/data-flow-repository.js';
function createTestDb() {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(SCHEMA_SQL);
    runMigrations(db);
    return db;
}
describe('DataFlowRepository', () => {
    let db;
    let repo;
    beforeEach(() => {
        db = createTestDb();
        db.prepare('INSERT INTO projects (id, name, root_path) VALUES (?, ?, ?)').run(1, 'default', '/test');
        repo = new DataFlowRepository(db);
    });
    describe('getOrCreateResource', () => {
        it('creates a new resource', () => {
            const resource = repo.getOrCreateResource('fs.readFile("/input.txt")', 'FILE', '/input.txt');
            expect(resource.id).toBe(1);
            expect(resource.qualifiedName).toBe('fs.readFile("/input.txt")');
            expect(resource.kind).toBe('FILE');
            expect(resource.identity).toBe('/input.txt');
        });
        it('returns existing resource on duplicate', () => {
            const resource1 = repo.getOrCreateResource('processInput', 'ENV', 'inputSource');
            const resource2 = repo.getOrCreateResource('processInput', 'ENV', 'inputSource');
            expect(resource1.id).toBe(resource2.id);
        });
    });
    describe('recordFlow', () => {
        it('records a data flow between resources', () => {
            const result = repo.recordFlow({
                fromResourceQualifiedName: 'fs.readFile("/input.txt")',
                fromResourceKind: 'FILE',
                fromResourceIdentity: '/input.txt',
                toResourceQualifiedName: 'processInput',
                toResourceKind: 'ENV',
                toResourceIdentity: 'inputSource',
                kind: 'arg',
                projectId: 1,
            });
            expect(result.id).toBe(1);
            expect(result.fromResource.kind).toBe('FILE');
            expect(result.toResource.kind).toBe('ENV');
            expect(result.kind).toBe('arg');
        });
        it('records flow with via information', () => {
            const result = repo.recordFlow({
                fromResourceQualifiedName: 'source1',
                fromResourceKind: 'FILE',
                fromResourceIdentity: '/src.ts',
                toResourceQualifiedName: 'sink1',
                toResourceKind: 'ENV',
                toResourceIdentity: 'sink',
                kind: 'arg',
                via: 'processData',
                sourceFunctionName: 'processData',
                targetFunctionName: 'processData',
                projectId: 1,
            });
            expect(result.via).toBe('processData');
            expect(result.sourceFunctionName).toBe('processData');
        });
    });
    describe('getFlows', () => {
        it('returns all flows for a project', () => {
            repo.recordFlow({
                fromResourceQualifiedName: 'src1',
                fromResourceKind: 'FILE',
                fromResourceIdentity: '/a.ts',
                toResourceQualifiedName: 'sink1',
                toResourceKind: 'ENV',
                toResourceIdentity: 'sink',
                kind: 'arg',
                projectId: 1,
            });
            repo.recordFlow({
                fromResourceQualifiedName: 'src2',
                fromResourceKind: 'NETWORK',
                fromResourceIdentity: 'api/data',
                toResourceQualifiedName: 'sink2',
                toResourceKind: 'DATABASE',
                toResourceIdentity: 'db',
                kind: 'resource',
                projectId: 1,
            });
            const flows = repo.getFlows(1);
            expect(flows).toHaveLength(2);
        });
        it('returns empty array for project with no flows', () => {
            const flows = repo.getFlows(1);
            expect(flows).toHaveLength(0);
        });
    });
    describe('getResourceFlows', () => {
        it('returns incoming and outgoing flows for a resource', () => {
            repo.recordFlow({
                fromResourceQualifiedName: 'src1',
                fromResourceKind: 'FILE',
                fromResourceIdentity: '/a.ts',
                toResourceQualifiedName: 'middle',
                toResourceKind: 'ENV',
                toResourceIdentity: 'mid',
                kind: 'arg',
                projectId: 1,
            });
            repo.recordFlow({
                fromResourceQualifiedName: 'middle',
                fromResourceKind: 'ENV',
                fromResourceIdentity: 'mid',
                toResourceQualifiedName: 'sink1',
                toResourceKind: 'DATABASE',
                toResourceIdentity: 'db',
                kind: 'arg',
                projectId: 1,
            });
            const flows = repo.getResourceFlows('middle');
            expect(flows).toHaveLength(2);
            expect(flows.some(f => f.direction === 'from')).toBe(true);
            expect(flows.some(f => f.direction === 'to')).toBe(true);
        });
        it('returns empty array for non-existent resource', () => {
            const flows = repo.getResourceFlows('nonexistent');
            expect(flows).toHaveLength(0);
        });
    });
    describe('clearFlows', () => {
        it('deletes all flows for a project', () => {
            repo.recordFlow({
                fromResourceQualifiedName: 'src1',
                fromResourceKind: 'FILE',
                fromResourceIdentity: '/a.ts',
                toResourceQualifiedName: 'sink1',
                toResourceKind: 'ENV',
                toResourceIdentity: 'sink',
                kind: 'arg',
                projectId: 1,
            });
            const deleted = repo.clearFlows(1);
            expect(deleted).toBe(1);
            expect(repo.getFlows(1)).toHaveLength(0);
        });
    });
});
//# sourceMappingURL=data-flow-repository.test.js.map