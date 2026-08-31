import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL } from '../../src/storage/schema.js';
import { runMigrations } from '../../src/storage/migrations.js';
import { ProjectRepository } from '../../src/storage/repositories/project-repository.js';
function createTestDb() {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(SCHEMA_SQL);
    runMigrations(db);
    return db;
}
describe('ProjectRepository', () => {
    let db;
    let repo;
    beforeEach(() => {
        db = createTestDb();
        repo = new ProjectRepository(db);
    });
    describe('create', () => {
        it('creates a new project', () => {
            const project = repo.create('test-project', '/test/path', 'A test project');
            expect(project.id).toBe(1);
            expect(project.name).toBe('test-project');
            expect(project.rootPath).toBe('/test/path');
            expect(project.description).toBe('A test project');
        });
        it('creates a project without description', () => {
            const project = repo.create('no-desc', '/path');
            expect(project.description).toBeNull();
        });
    });
    describe('getById', () => {
        it('retrieves a project by id', () => {
            repo.create('test', '/test');
            const project = repo.getById(1);
            expect(project).not.toBeNull();
            expect(project.name).toBe('test');
        });
        it('returns null for non-existent id', () => {
            const project = repo.getById(999);
            expect(project).toBeNull();
        });
    });
    describe('getByName', () => {
        it('retrieves a project by name', () => {
            repo.create('my-project', '/my/path');
            const project = repo.getByName('my-project');
            expect(project).not.toBeNull();
            expect(project.rootPath).toBe('/my/path');
        });
        it('returns null for non-existent name', () => {
            const project = repo.getByName('nonexistent');
            expect(project).toBeNull();
        });
    });
    describe('list', () => {
        it('lists all projects with file counts', () => {
            repo.create('project-a', '/a');
            repo.create('project-b', '/b');
            const projects = repo.list();
            expect(projects).toHaveLength(2);
            expect(projects[0].name).toBe('project-a');
            expect(projects[0].fileCount).toBe(0);
            expect(projects[1].name).toBe('project-b');
            expect(projects[1].fileCount).toBe(0);
        });
        it('returns file count when files exist', () => {
            repo.create('proj', '/proj');
            db.prepare('INSERT INTO files (project_id, path, relative_path) VALUES (?, ?, ?)')
                .run(1, '/proj/file1.ts', 'file1.ts');
            db.prepare('INSERT INTO files (project_id, path, relative_path) VALUES (?, ?, ?)')
                .run(1, '/proj/file2.ts', 'file2.ts');
            const projects = repo.list();
            expect(projects).toHaveLength(1);
            expect(projects[0].fileCount).toBe(2);
        });
    });
    describe('delete', () => {
        it('deletes a project and its files', () => {
            // Create a project with explicit id > 1 to avoid default project protection
            db.prepare('INSERT INTO projects (id, name, root_path) VALUES (?, ?, ?)').run(100, 'to-delete', '/delete');
            db.prepare('INSERT INTO files (project_id, path, relative_path) VALUES (?, ?, ?)')
                .run(100, '/delete/file.ts', 'file.ts');
            const result = repo.delete(100);
            expect(result.success).toBe(true);
            expect(result.deletedFiles).toBe(1);
            expect(repo.getById(100)).toBeNull();
        });
        it('prevents deleting project with id 1', () => {
            const result = repo.delete(1);
            expect(result.success).toBe(false);
            expect(result.error).toContain('Cannot delete default project');
        });
        it('returns error for non-existent project', () => {
            const result = repo.delete(999);
            expect(result.success).toBe(false);
            expect(result.error).toContain('not found');
        });
    });
    describe('updateScanTimestamp', () => {
        it('updates the last scanned timestamp', () => {
            const project = repo.create('test', '/test');
            expect(project.lastScanned).toBeDefined();
            repo.updateScanTimestamp(1);
            const updated = repo.getById(1);
            expect(updated).not.toBeNull();
        });
    });
});
//# sourceMappingURL=project-repository.test.js.map