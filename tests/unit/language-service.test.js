import { describe, it, expect } from 'vitest';
import { createLangParser, detectLanguageFromPath } from '../../src/parser/language-service.js';
describe('language-service - detectLanguageFromPath', () => {
    it('detects structural languages from extensions', () => {
        expect(detectLanguageFromPath('a.ts')).toBe('typescript');
        expect(detectLanguageFromPath('a.tsx')).toBe('typescript');
        expect(detectLanguageFromPath('a.js')).toBe('javascript');
        expect(detectLanguageFromPath('a.py')).toBe('python');
        expect(detectLanguageFromPath('a.go')).toBe('go');
        expect(detectLanguageFromPath('a.rs')).toBe('rust');
        expect(detectLanguageFromPath('a.java')).toBe('java');
    });
    it('returns null for unsupported extensions', () => {
        expect(detectLanguageFromPath('a.txt')).toBeNull();
        expect(detectLanguageFromPath('a.md')).toBeNull();
    });
});
describe('language-service - createLangParser (parser pool)', () => {
    it('parses TypeScript content', () => {
        const res = createLangParser('test.ts', 'export function foo(a: number): number { return a + 1; }');
        expect(res).not.toBeNull();
        expect(res.language).toBe('typescript');
        expect(res.root.type).toBe('program');
        expect(res.root.namedChildren.length).toBeGreaterThan(0);
    });
    it('parses Python content', () => {
        const res = createLangParser('test.py', 'def foo(a):\n    return a + 1\n');
        expect(res).not.toBeNull();
        expect(res.language).toBe('python');
        expect(res.root.type).toBe('module');
    });
    it('parses Go content', () => {
        const res = createLangParser('test.go', 'package main\nfunc main() {}\n');
        expect(res).not.toBeNull();
        expect(res.language).toBe('go');
        expect(res.root.type).toBe('source_file');
    });
    it('reuses the pooled parser across repeated calls (same grammar)', () => {
        // The pool must not break under repeated parse() calls on one grammar.
        for (let i = 0; i < 10; i++) {
            const res = createLangParser('test.ts', `export const v${i}: number = ${i};`);
            expect(res).not.toBeNull();
            expect(res.root.type).toBe('program');
        }
    });
    it('interleaves grammars without cross-talk', () => {
        for (let i = 0; i < 5; i++) {
            const ts = createLangParser('a.ts', 'const x: number = 1;');
            const py = createLangParser('b.py', 'x = 1\n');
            expect(ts.language).toBe('typescript');
            expect(py.language).toBe('python');
            expect(ts.root.type).toBe('program');
            expect(py.root.type).toBe('module');
        }
    });
    it('returns null for unsupported extensions', () => {
        expect(createLangParser('test.txt', 'hello')).toBeNull();
    });
});
//# sourceMappingURL=language-service.test.js.map