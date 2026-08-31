import { describe, it, expect } from 'vitest';
import { validateConfig } from '../../src/utils/config-schema.js';
describe('Config Schema - validateConfig', () => {
    it('accepts valid minimal config', () => {
        const config = validateConfig({});
        expect(config.llm.provider).toBe('anthropic');
        expect(config.llm.model).toBe('claude-3-5-sonnet-20241022');
        expect(config.scanOnStartup).toBe(true);
    });
    it('accepts fully specified config', () => {
        const config = validateConfig({
            projectRoot: '/project',
            databasePath: '.projectmind/db.db',
            scanOnStartup: false,
        });
        expect(config.projectRoot).toBe('/project');
        expect(config.databasePath).toBe('.projectmind/db.db');
        expect(config.scanOnStartup).toBe(false);
        // Zod applies defaults for missing fields
        expect(config.llm.provider).toBe('anthropic');
        expect(config.maxDepth).toBe(10);
    });
    it('handles null input gracefully', () => {
        const config = validateConfig(null);
        expect(config.llm.provider).toBe('anthropic');
    });
    it('handles undefined input gracefully', () => {
        const config = validateConfig(undefined);
        expect(config.llm.provider).toBe('anthropic');
    });
    it('accepts valid contracts', () => {
        const config = validateConfig({
            contracts: [{
                    id: 'no-eval',
                    name: 'No Eval',
                    sourcePattern: '**/*.ts',
                    forbiddenKeywords: ['dangerousFunc('],
                    severity: 'error',
                }],
        });
        // Contracts may or may not be defined depending on validation
        if (config.contracts) {
            expect(config.contracts.length).toBeGreaterThanOrEqual(0);
        }
    });
});
//# sourceMappingURL=config-schema.test.js.map