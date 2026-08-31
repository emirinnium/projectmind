import { describe, it, expect } from 'vitest';
import { diffHunks, threeWayMerge, mergeTexts, computeTeamMemoryStore, buildMergeSuggestion, } from '../../src/core/team-memory/merge.js';
describe('diffHunks (Myers line diff)', () => {
    it('returns no hunks for identical input', () => {
        expect(diffHunks(['a', 'b', 'c'], ['a', 'b', 'c'])).toEqual([]);
    });
    it('treats a write into empty base as one insertion at 0', () => {
        expect(diffHunks([], ['x', 'y'])).toEqual([{ baseStart: 0, baseEnd: 0, lines: ['x', 'y'] }]);
    });
    it('treats a full deletion as one hunk with no replacement lines', () => {
        expect(diffHunks(['a', 'b'], [])).toEqual([{ baseStart: 0, baseEnd: 2, lines: [] }]);
    });
    it('detects a mid-file replacement', () => {
        expect(diffHunks(['a', 'b', 'c'], ['a', 'X', 'c'])).toEqual([{ baseStart: 1, baseEnd: 2, lines: ['X'] }]);
    });
    it('detects a trailing insertion', () => {
        expect(diffHunks(['a', 'b'], ['a', 'b', 'c'])).toEqual([{ baseStart: 2, baseEnd: 2, lines: ['c'] }]);
    });
    it('detects a mid-file deletion', () => {
        expect(diffHunks(['a', 'b', 'c'], ['a', 'c'])).toEqual([{ baseStart: 1, baseEnd: 2, lines: [] }]);
    });
    it('collapses adjacent changes into a single hunk', () => {
        expect(diffHunks(['a', 'b', 'c', 'd'], ['a', 'X', 'Y', 'd'])).toEqual([
            { baseStart: 1, baseEnd: 3, lines: ['X', 'Y'] },
        ]);
    });
});
describe('threeWayMerge', () => {
    it('is a no-op when nothing changed', () => {
        const r = threeWayMerge(['a', 'b'], ['a', 'b'], ['a', 'b']);
        expect(r.clean).toBe(true);
        expect(r.mergedLines).toEqual(['a', 'b']);
        expect(r.conflicts).toHaveLength(0);
    });
    it('fast-forwards when local is unchanged (equals base)', () => {
        const r = threeWayMerge(['a', 'b'], ['a', 'b'], ['a', 'b', 'c']);
        expect(r.clean).toBe(true);
        expect(r.mergedLines).toEqual(['a', 'b', 'c']);
    });
    it('applies identical changes from both sides once', () => {
        const r = threeWayMerge(['a', 'b'], ['a', 'X', 'b'], ['a', 'X', 'b']);
        expect(r.clean).toBe(true);
        expect(r.mergedLines).toEqual(['a', 'X', 'b']);
    });
    it('merges disjoint changes cleanly', () => {
        const r = threeWayMerge(['a', 'b', 'c'], ['A', 'b', 'c'], ['a', 'b', 'C']);
        expect(r.clean).toBe(true);
        expect(r.mergedLines).toEqual(['A', 'b', 'C']);
    });
    it('emits git-style markers for a real conflict', () => {
        const r = threeWayMerge(['a', 'b', 'c'], ['a', 'X', 'c'], ['a', 'Y', 'c']);
        expect(r.clean).toBe(false);
        expect(r.conflicts).toHaveLength(1);
        expect(r.conflicts[0]).toMatchObject({ baseStart: 1, baseEnd: 2 });
        expect(r.mergedLines).toEqual(['a', '<<<<<<<', 'X', '=======', 'Y', '>>>>>>>', 'c']);
    });
    it('applies a local deletion when the remote side is untouched', () => {
        const r = threeWayMerge(['a', 'b', 'c'], ['a', 'c'], ['a', 'b', 'c']);
        expect(r.clean).toBe(true);
        expect(r.mergedLines).toEqual(['a', 'c']);
    });
    it('conflicts when both sides insert different content at the same position', () => {
        const r = threeWayMerge(['a', 'b'], ['a', 'L', 'b'], ['a', 'R', 'b']);
        expect(r.clean).toBe(false);
        expect(r.conflicts).toHaveLength(1);
    });
    it('treats staggered overlapping hunks as a conflict', () => {
        // local deletes base lines [1,3), remote replaces base line [2,3)
        const r = threeWayMerge(['a', 'b', 'c', 'd'], ['a', 'd'], ['a', 'b', 'Y', 'd']);
        expect(r.clean).toBe(false);
        expect(r.conflicts.length).toBeGreaterThan(0);
    });
    it('handles append-only edits at the end of the base', () => {
        const r = threeWayMerge(['a', 'b'], ['a', 'b'], ['a', 'b', 'c', 'd']);
        expect(r.clean).toBe(true);
        expect(r.mergedLines).toEqual(['a', 'b', 'c', 'd']);
    });
    it('mergeTexts works over newline-separated text', () => {
        const r = mergeTexts('line1\nline2', 'line1\nline2', 'line1\nline2\nline3');
        expect(r.clean).toBe(true);
        expect(r.merged).toBe('line1\nline2\nline3');
    });
});
describe('computeTeamMemoryStore (3-way write decision)', () => {
    it('plain insert for a new key', () => {
        const r = computeTeamMemoryStore(null, 'v1');
        expect(r.status).toBe('stored');
        expect(r.storedValue).toBe('v1');
        expect(r.previousValue).toBe('');
        expect(r.shouldWrite).toBe(true);
        expect(r.nextBaseValue).toBeNull();
    });
    it('idempotent no-op when the value is unchanged', () => {
        const r = computeTeamMemoryStore({ value: 'v', baseValue: null }, 'v');
        expect(r.status).toBe('stored');
        expect(r.shouldWrite).toBe(false);
        expect(r.storedValue).toBe('v');
    });
    it('fast-forwards when the stored copy is stale (no recorded ancestor)', () => {
        const r = computeTeamMemoryStore({ value: 'v1', baseValue: null }, 'v2');
        expect(r.status).toBe('stored');
        expect(r.storedValue).toBe('v2');
        expect(r.shouldWrite).toBe(true);
        expect(r.nextBaseValue).toBe('v1');
    });
    it('does a clean 3-way merge when both sides changed disjoint regions', () => {
        // base was 'a\nb\nc'; local changed line 1, remote changes line 3
        const r = computeTeamMemoryStore({ value: 'A\nb\nc', baseValue: 'a\nb\nc' }, 'a\nb\nC');
        expect(r.status).toBe('merged');
        expect(r.storedValue).toBe('A\nb\nC');
        expect(r.shouldWrite).toBe(true);
        expect(r.previousValue).toBe('A\nb\nc');
        expect(r.nextBaseValue).toBe('A\nb\nc');
        expect(r.conflicts).toHaveLength(0);
    });
    it('keeps the stored value untouched on conflict — never last-write-wins', () => {
        const r = computeTeamMemoryStore({ value: 'a\nX\nc', baseValue: 'a\nb\nc' }, 'a\nY\nc');
        expect(r.status).toBe('conflict');
        expect(r.storedValue).toBe('a\nX\nc');
        expect(r.shouldWrite).toBe(false);
        expect(r.conflicts).toHaveLength(1);
        expect(r.mergedValue).toContain('<<<<<<<');
    });
});
describe('buildMergeSuggestion', () => {
    const conflicts = [
        { baseStart: 1, baseEnd: 2, localLines: ['X'], remoteLines: ['Y'] },
    ];
    it('returns a clean merged value when there are no conflicts', async () => {
        const s = await buildMergeSuggestion('a\nb', 'A\nb', 'a\nB', [], null);
        expect(s.llmGenerated).toBe(false);
        expect(s.resolution).toBe('A\nB');
    });
    it('uses the deterministic fallback without a provider (keeps local, marks remote)', async () => {
        const s = await buildMergeSuggestion('a\nb\nc', 'a\nX\nc', 'a\nY\nc', conflicts, null);
        expect(s.llmGenerated).toBe(false);
        expect(s.resolution).toContain('a\nX\nc');
        expect(s.resolution).toContain('UNMERGED REMOTE');
        expect(s.reasoning).toContain('kept stored');
    });
    it('uses an available LLM provider for the resolution', async () => {
        const provider = {
            isAvailable: () => true,
            analyze: async () => ({ content: 'a\nXY\nc' }),
        };
        const s = await buildMergeSuggestion('a\nb\nc', 'a\nX\nc', 'a\nY\nc', conflicts, provider);
        expect(s.llmGenerated).toBe(true);
        expect(s.resolution).toBe('a\nXY\nc');
    });
    it('falls back when the provider throws', async () => {
        const provider = {
            isAvailable: () => true,
            analyze: async () => {
                throw new Error('LLM unavailable');
            },
        };
        const s = await buildMergeSuggestion('a\nb\nc', 'a\nX\nc', 'a\nY\nc', conflicts, provider);
        expect(s.llmGenerated).toBe(false);
        expect(s.resolution).toContain('UNMERGED REMOTE');
    });
});
//# sourceMappingURL=team-memory-merge.test.js.map