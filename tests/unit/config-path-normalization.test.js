import { describe, it, expect } from 'vitest';
import { mergeWithDefaults } from '../../src/utils/config.js';
/**
 * Hermetic tests for state-path normalization in mergeWithDefaults.
 *
 * These assert that databasePath / embeddingsDir ALWAYS resolve inside
 * `join(projectRoot, '.projectmind')` regardless of how the user overrides them.
 * No real files are written — we only inspect the returned path strings.
 */
const FAKE_ROOT = '/tmp/fake-root';
function merge(overrides = {}) {
    return mergeWithDefaults({ projectRoot: FAKE_ROOT, ...overrides });
}
describe('config path normalization', () => {
    it('relocates a bare databasePath into .projectmind/', () => {
        const config = merge({ databasePath: 'pm-knowledge.db' });
        expect(config.databasePath).toBe('.projectmind/pm-knowledge.db');
    });
    it('relocates a "./" prefixed databasePath into .projectmind/', () => {
        const config = merge({ databasePath: './pm-knowledge.db' });
        expect(config.databasePath).toBe('.projectmind/pm-knowledge.db');
    });
    it('relocates an absolute databasePath into .projectmind/ (does not escape)', () => {
        const config = merge({ databasePath: '/tmp/foo.db' });
        expect(config.databasePath).toBe('.projectmind/foo.db');
    });
    it('keeps an already-correct .projectmind/ databasePath unchanged', () => {
        const config = merge({ databasePath: '.projectmind/pm-knowledge.db' });
        expect(config.databasePath).toBe('.projectmind/pm-knowledge.db');
    });
    it('forces an escaping ../ databasePath under .projectmind/', () => {
        const config = merge({ databasePath: '../escape.db' });
        expect(config.databasePath).toBe('.projectmind/escape.db');
    });
    it('relocates a bare embeddingsDir into .projectmind/', () => {
        const config = merge({ embeddingsDir: 'embeddings' });
        expect(config.embeddingsDir).toBe('.projectmind/embeddings');
    });
});
//# sourceMappingURL=config-path-normalization.test.js.map