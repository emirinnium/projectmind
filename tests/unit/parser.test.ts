import { describe, it, expect } from 'vitest';
import { detectLanguage, parseFile } from '../../src/parser/ast-parser.js';

describe('Parser - detectLanguage', () => {
  it('detects TypeScript files', () => {
    expect(detectLanguage('test.ts')).toBe('typescript');
    expect(detectLanguage('test.tsx')).toBe('typescript');
  });

  it('detects JavaScript files', () => {
    expect(detectLanguage('test.js')).toBe('javascript');
    expect(detectLanguage('test.jsx')).toBe('javascript');
    expect(detectLanguage('test.mjs')).toBe('javascript');
    expect(detectLanguage('test.cjs')).toBe('javascript');
  });

  it('returns unknown for unrecognized extensions', () => {
    expect(detectLanguage('test.txt')).toBe('unknown');
    expect(detectLanguage('test')).toBe('unknown');
    expect(detectLanguage('test.exe')).toBe('unknown');
  });
});

describe('Parser - parseFile', () => {
  it('parses TypeScript function declarations', () => {
    const result = parseFile(
      'test.ts',
      'export function hello(name: string): string { return "hello"; }',
    );
    expect(result).not.toBeNull();
    expect(result!.language).toBe('typescript');
    expect(result!.functions.length).toBeGreaterThanOrEqual(1);
  });

  it('parses TypeScript class declarations', () => {
    const result = parseFile('test.ts', 'export class MyClass { method() {} }');
    expect(result).not.toBeNull();
    expect(result!.classes.length).toBeGreaterThanOrEqual(1);
  });

  it('retains every heritage type and counts modern control-flow constructs', () => {
    const result = parseFile(
      'heritage.ts',
      'interface A {} interface B {} class Child extends Base implements A, B { run(x?: X) { return x?.value ?? fallback(); } }',
    );
    expect(result?.classes[0]?.extends).toBe('Base');
    expect(result?.classes[0]?.implements).toEqual(['A', 'B']);
    expect(result?.functions[0]?.cyclomaticComplexity).toBeGreaterThan(2);
  });

  it('does not count terminal throws as additional cyclomatic branches', () => {
    const result = parseFile(
      'errors.ts',
      'function fail() { throw new Error("bad"); } function recover() { try { return 1; } catch { return 0; } }',
    );
    expect(result?.functions.find((fn) => fn.name === 'fail')?.cyclomaticComplexity).toBe(1);
    expect(result?.functions.find((fn) => fn.name === 'recover')?.cyclomaticComplexity).toBe(2);
  });

  it('parses TypeScript imports', () => {
    const result = parseFile('test.ts', "import { foo } from './bar';");
    expect(result).not.toBeNull();
    expect(result!.imports.length).toBeGreaterThanOrEqual(1);
  });

  it('records named static call candidates with source locations', () => {
    const result = parseFile(
      'calls.ts',
      'function caller() {\n  callee();\n}\nfunction callee() { return 1; }',
    );
    expect(result?.staticCalls).toContainEqual({
      fromFunctionName: 'caller',
      toFunctionName: 'callee',
      line: 2,
    });
  });

  it('parses static CommonJS require dependencies', () => {
    const result = parseFile('test.js', "const { foo } = require('./bar.js');");
    expect(result).not.toBeNull();
    expect(result!.imports).toContainEqual({
      source: './bar.js',
      named: [],
      kind: 'require',
    });
  });

  it('returns null for unsupported file types', () => {
    const result = parseFile('test.txt', 'some content');
    expect(result).toBeNull();
  });

  it('handles empty files', () => {
    const result = parseFile('test.ts', '');
    expect(result).not.toBeNull();
    expect(result!.functions).toHaveLength(0);
    expect(result!.classes).toHaveLength(0);
  });
});
