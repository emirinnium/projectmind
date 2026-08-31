import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL } from '../../src/storage/schema.js';
import { runMigrations } from '../../src/storage/migrations.js';
import { setDatabase } from '../../src/storage/database.js';
import { KnowledgeGraph } from '../../src/storage/knowledge-graph.js';
import { TaintAnalyzer } from '../../src/parser/taint-analyzer.js';
import { StructuralSearcher } from '../../src/parser/structural-search.js';
function createTestDb() {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(SCHEMA_SQL);
    runMigrations(db);
    setDatabase(db);
    const kg = new KnowledgeGraph(db);
    return { db, kg };
}
// ---------------------------------------------------------------------------
// Fixtures for structural search — written to a temp dir, cleaned up after.
// ---------------------------------------------------------------------------
const FIXTURE_DIR = join(tmpdir(), 'pm-multilang-analysis-' + Date.now());
const PY_FILE = join(FIXTURE_DIR, 'sample.py');
const PY_CONTENT = [
    'def handle_input(raw):',
    '    return raw',
    '',
    'def other():',
    '    return 1',
    '',
].join('\n');
const GO_FILE = join(FIXTURE_DIR, 'sample.go');
const GO_CONTENT = [
    'package main',
    '',
    'import ("os"; "os/exec")',
    '',
    'func main() {',
    '    data := os.Getenv("K")',
    '    exec.Command(data)',
    '}',
    '',
].join('\n');
const RS_FILE = join(FIXTURE_DIR, 'sample.rs');
const RS_CONTENT = [
    'fn run() {',
    '    let cmd = std::process::Command::new("ls");',
    '    let _ = cmd.output();',
    '}',
    '',
].join('\n');
const JAVA_FILE = join(FIXTURE_DIR, 'Sample.java');
const JAVA_CONTENT = [
    'class Sample {',
    '    public static void main(String[] args) {',
    '        String v = System.getenv("K");',
    '        Runtime.getRuntime().exec(v);',
    '    }',
    '}',
    '',
].join('\n');
beforeAll(() => {
    mkdirSync(FIXTURE_DIR, { recursive: true });
    writeFileSync(PY_FILE, PY_CONTENT, 'utf-8');
    writeFileSync(GO_FILE, GO_CONTENT, 'utf-8');
    writeFileSync(RS_FILE, RS_CONTENT, 'utf-8');
    writeFileSync(JAVA_FILE, JAVA_CONTENT, 'utf-8');
});
afterAll(() => {
    rmSync(FIXTURE_DIR, { recursive: true, force: true });
});
// ===========================================================================
// TAINT ANALYSIS (multi-language)
// ===========================================================================
describe('TaintAnalyzer - multi-language', () => {
    let analyzer;
    beforeAll(() => {
        const { kg } = createTestDb();
        analyzer = new TaintAnalyzer(kg);
    });
    it('python: os.environ -> subprocess.run', () => {
        const code = [
            'import os',
            'import subprocess',
            'data = os.environ["SECRET"]',
            'subprocess.run(data)',
        ].join('\n');
        const flows = analyzer.analyzeSource('app.py', code, 'python');
        // The sink flow (data → subprocess.run) carries the ENV identity 'SECRET';
        // the source-call flow (data passed INTO subprocess.run as a source API)
        // overrides identity with the first argument instead.
        const f = flows.find((x) => x.sink.kind === 'SOCKET' && x.source.identity === 'SECRET');
        expect(f).toBeDefined();
        expect(f.source.kind).toBe('ENV');
        expect(f.viaVariable).toBe('data');
        expect(f.sink.qualifiedName).toBe('subprocess.run');
    });
    it('go: os.Getenv -> exec.Command', () => {
        const code = [
            'package main',
            'import ("os"; "os/exec")',
            'func main() {',
            '  data := os.Getenv("K")',
            '  exec.Command(data)',
            '}',
        ].join('\n');
        const flows = analyzer.analyzeSource('main.go', code, 'go');
        expect(flows.some((f) => f.source.kind === 'ENV' && f.sink.kind === 'SOCKET' && f.viaVariable === 'data')).toBe(true);
    });
    it('rust: std::env::var(...).unwrap() -> Command::new', () => {
        const code = [
            'fn main() {',
            '  let v = std::env::var("K").unwrap();',
            '  std::process::Command::new(v);',
            '}',
        ].join('\n');
        const flows = analyzer.analyzeSource('lib.rs', code, 'rust');
        const f = flows.find((x) => x.sink.kind === 'SOCKET');
        expect(f).toBeDefined();
        expect(f.source.kind).toBe('ENV');
        expect(f.viaVariable).toBe('v');
        expect(f.sink.qualifiedName).toBe('std::process::Command::new');
    });
    it('java: System.getenv -> Runtime.exec', () => {
        const code = [
            'class Main {',
            '  public static void main(String[] args) {',
            '    String v = System.getenv("K");',
            '    Runtime.getRuntime().exec(v);',
            '  }',
            '}',
        ].join('\n');
        const flows = analyzer.analyzeSource('Main.java', code, 'java');
        // Sink flow identity = 'K' (from System.getenv("K")); the source-call flow
        // for the Runtime.exec source pattern overrides identity with 'v'.
        const f = flows.find((x) => x.sink.kind === 'SOCKET' && x.source.identity === 'K');
        expect(f).toBeDefined();
        expect(f.source.kind).toBe('ENV');
        expect(f.viaVariable).toBe('v');
    });
    it('python: returns no flows for clean code', () => {
        const code = ['def f():', '    x = 1', '    return x', ''].join('\n');
        expect(analyzer.analyzeSource('clean.py', code, 'python')).toHaveLength(0);
    });
    it('python: file -> sys.stdout (FILE to STDOUT-like sink via open)', () => {
        const code = [
            'data = open("secrets.txt").read()',
            'open("out.txt", "w").write(data)',
        ].join('\n');
        const flows = analyzer.analyzeSource('io.py', code, 'python');
        const f = flows.find((x) => x.source.kind === 'FILE' && x.sink.kind === 'FILE');
        expect(f).toBeDefined();
        expect(f.viaVariable).toBe('data');
    });
    it('recordFlows accepts non-TS languages', () => {
        const code = [
            'import os',
            'import subprocess',
            'data = os.environ["SECRET"]',
            'subprocess.run(data)',
        ].join('\n');
        const recorded = analyzer.recordFlows('app.py', code, 'python');
        expect(recorded).toBeGreaterThanOrEqual(1);
    });
});
// ===========================================================================
// STRUCTURAL SEARCH (multi-language)
// ===========================================================================
const searcher = new StructuralSearcher();
describe('StructuralSearcher - multi-language search', () => {
    it('python: finds function_definition by name pattern', () => {
        const matches = searcher.search({ nodeKind: 'function_definition', namePattern: '^handle' }, [PY_FILE]);
        expect(matches.length).toBe(1);
        expect(matches[0].language).toBe('python');
        expect(matches[0].text).toContain('handle_input');
        expect(matches[0].startLine).toBe(1);
    });
    it('go: finds function_declaration by name pattern', () => {
        const matches = searcher.search({ nodeKind: 'function_declaration', namePattern: '^main' }, [GO_FILE]);
        expect(matches.length).toBe(1);
        expect(matches[0].language).toBe('go');
    });
    it('rust: finds function_item containing text', () => {
        const matches = searcher.search({ nodeKind: 'function_item', containsText: 'Command' }, [RS_FILE]);
        expect(matches.length).toBe(1);
        expect(matches[0].language).toBe('rust');
    });
    it('java: finds static method_declaration', () => {
        const matches = searcher.search({ nodeKind: 'method_declaration', hasModifier: 'static' }, [JAVA_FILE]);
        expect(matches.length).toBeGreaterThanOrEqual(1);
        expect(matches[0].language).toBe('java');
        expect(matches[0].text).toContain('main');
    });
    it('respects maxResults across multi-language files', () => {
        const matches = searcher.search({ nodeKind: 'function_definition', maxResults: 1 }, [PY_FILE]);
        expect(matches.length).toBeLessThanOrEqual(1);
    });
    it('returns empty when nothing matches', () => {
        const matches = searcher.search({ nodeKind: 'function_definition', namePattern: '^nope' }, [PY_FILE]);
        expect(matches).toHaveLength(0);
    });
});
describe('StructuralSearcher - multi-language replace (dry-run)', () => {
    it('python: produces diffs without writing to disk', () => {
        const result = searcher.replace({
            nodeKind: 'function_definition',
            namePattern: '^other',
            replacement: 'def other():\n    return 0',
            dryRun: true,
        }, [PY_FILE]);
        expect(result.dryRun).toBe(true);
        expect(result.replaced).toBe(1);
        expect(result.diffs.length).toBeGreaterThanOrEqual(1);
        expect(result.diffs[0].original).toContain('def other');
        expect(result.diffs[0].transformed).toContain('return 0');
        expect(result.diffs[0].filePath).toBe(PY_FILE);
    });
    it('does not modify original file in dry-run', () => {
        const { readFileSync } = require('node:fs');
        const before = readFileSync(PY_FILE, 'utf-8');
        searcher.replace({
            nodeKind: 'function_definition',
            namePattern: '^other',
            replacement: 'def other():\n    return 0',
            dryRun: true,
        }, [PY_FILE]);
        const after = readFileSync(PY_FILE, 'utf-8');
        expect(after).toBe(before);
    });
    it('java: replaces a method with direct splices', () => {
        const result = searcher.replace({
            nodeKind: 'method_declaration',
            hasModifier: 'static',
            replacement: 'private static String helper() {\n        return "h";\n    }',
            dryRun: true,
        }, [JAVA_FILE]);
        expect(result.replaced).toBeGreaterThanOrEqual(1);
        expect(result.diffs[0].transformed).toContain('helper()');
    });
});
//# sourceMappingURL=multilang-analysis.test.js.map