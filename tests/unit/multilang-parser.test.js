import { describe, it, expect } from 'vitest';
import { parseFile } from '../../src/parser/ast-parser.js';
describe('MultilangParser - Language Detection', () => {
    it('detects TypeScript files', () => {
        const result = parseFile('test.ts', 'const x: number = 5;');
        expect(result).not.toBeNull();
        expect(result.language).toBe('typescript');
    });
    it('detects TSX files', () => {
        const result = parseFile('component.tsx', 'const App = () => <div>Hello</div>;');
        expect(result).not.toBeNull();
        expect(result.language).toBe('typescript');
    });
    it('detects JavaScript files', () => {
        const result = parseFile('script.js', 'const x = 5;');
        expect(result).not.toBeNull();
        expect(result.language).toBe('javascript');
    });
    it('detects JSX files', () => {
        const result = parseFile('component.jsx', 'const App = () => <div>Hello</div>;');
        expect(result).not.toBeNull();
        expect(result.language).toBe('javascript');
    });
    it('detects Python files', () => {
        const result = parseFile('script.py', 'def hello():\n    print("hello")');
        expect(result).not.toBeNull();
        expect(result.language).toBe('python');
    });
    it('detects Go files', () => {
        const result = parseFile('main.go', 'package main\n\nfunc main() {}');
        expect(result).not.toBeNull();
        expect(result.language).toBe('go');
    });
    it('detects Rust files', () => {
        const result = parseFile('lib.rs', 'fn main() {}');
        expect(result).not.toBeNull();
        expect(result.language).toBe('rust');
    });
    it('detects Java files', () => {
        const result = parseFile('Main.java', 'public class Main {}');
        expect(result).not.toBeNull();
        expect(result.language).toBe('java');
    });
    it('detects Ruby files', () => {
        const result = parseFile('app.rb', 'puts "hello"');
        expect(result).not.toBeNull();
        expect(result.language).toBe('ruby');
    });
    it('detects C++ files', () => {
        const result = parseFile('main.cpp', 'int main() { return 0; }');
        expect(result).not.toBeNull();
        expect(result.language).toBe('cpp');
    });
});
describe('MultilangParser - Parsing', () => {
    it('parses TypeScript functions', () => {
        const code = 'export function greet(name: string): string { return `Hello, ${name}`; }';
        const result = parseFile('greeting.ts', code);
        expect(result).not.toBeNull();
        expect(result.functions.length).toBeGreaterThanOrEqual(1);
    });
    it('parses TypeScript classes', () => {
        const code = 'export class Greeter { greet() { return "hello"; } }';
        const result = parseFile('greeter.ts', code);
        expect(result).not.toBeNull();
        expect(result.classes.length).toBeGreaterThanOrEqual(1);
    });
    it('parses TypeScript imports', () => {
        const code = "import { something } from './module';";
        const result = parseFile('module.ts', code);
        expect(result).not.toBeNull();
        expect(result.imports.length).toBeGreaterThanOrEqual(1);
    });
    it('returns null for unsupported file types', () => {
        const result = parseFile('readme.md', '# Hello');
        expect(result).toBeNull();
    });
    it('handles empty files', () => {
        const result = parseFile('empty.ts', '');
        expect(result).not.toBeNull();
        expect(result.functions).toHaveLength(0);
        expect(result.classes).toHaveLength(0);
        expect(result.imports).toHaveLength(0);
    });
    it('handles files with syntax errors gracefully', () => {
        const result = parseFile('broken.ts', 'const x = ;');
        expect(result).not.toBeNull();
    });
});
//# sourceMappingURL=multilang-parser.test.js.map