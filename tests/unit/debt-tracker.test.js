import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseManager } from '../../src/storage/database.js';
import { DebtTracker } from '../../src/core/debt/tracker.js';
let dbManager;
describe('DebtTracker', () => {
    let tracker;
    beforeEach(() => {
        dbManager = new DatabaseManager(':memory:');
        const db = dbManager.init();
        // Mock dependencies
        const kg = {
            getAllFiles: () => [],
            getAgentSessions: () => [],
        };
        const coherenceEngine = {
            analyze: () => ({}),
        };
        tracker = new DebtTracker(db, kg, coherenceEngine);
    });
    afterEach(() => {
        dbManager.close();
    });
    describe('getReport', () => {
        it('returns an empty debt report when no debt exists', () => {
            const report = tracker.getReport();
            expect(report).toBeDefined();
            expect(report.totalItems).toBe(0);
            expect(report.bySeverity.high).toBe(0);
            expect(report.bySeverity.medium).toBe(0);
            expect(report.bySeverity.low).toBe(0);
            expect(report.items).toHaveLength(0);
        });
    });
    describe('computeGenome', () => {
        it('returns genome data with coherence score', () => {
            const genome = tracker.computeGenome();
            expect(genome).toBeDefined();
            expect(genome.genomeData).toBeDefined();
            expect(typeof genome.coherenceScore).toBe('number');
            expect(genome.coherenceScore).toBeGreaterThanOrEqual(0);
            expect(genome.coherenceScore).toBeLessThanOrEqual(1);
        });
    });
    describe('getCacheStats', () => {
        it('returns cache stats', () => {
            const stats = tracker.getCacheStats();
            expect(stats).toBeDefined();
        });
    });
    describe('clearAllDebt', () => {
        it('clears all debt without error', () => {
            expect(() => tracker.clearAllDebt()).not.toThrow();
        });
    });
    describe('clearPatterns', () => {
        it('clears patterns without error', () => {
            expect(() => tracker.clearPatterns()).not.toThrow();
        });
    });
    describe('resolveDebt', () => {
        it('does not throw for non-existent debt id', () => {
            expect(() => tracker.resolveDebt(999)).not.toThrow();
        });
    });
});
//# sourceMappingURL=debt-tracker.test.js.map