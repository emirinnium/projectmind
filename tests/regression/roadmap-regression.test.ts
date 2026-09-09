import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertProjectPath, validateProjectPath } from '../../src/core/security/path-security.js';
import { readSourceRange } from '../../src/core/retrieval/byte-range.js';
import { makeSurgicalEditPlan, applySurgicalEdit } from '../../src/core/refactor/surgical-edit.js';
import { parseBenchmarkManifest } from '../../src/core/benchmark/manifest.js';
import { runBenchmark } from '../../src/core/benchmark/runner.js';
import { verifyMcpConfig } from '../../src/cli/commands/init-mcp-config.js';

function tempProject(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, 'src'));
  return root;
}

describe('roadmap regression corpus', () => {
  it.each(['../outside.ts', '/etc/passwd', 'C:\\Windows\\System32\\drivers\\etc\\hosts'])(
    'keeps foreign and escaping path conventions outside the trusted root: %s',
    (input) => {
      const root = tempProject('projectmind-regression-path-');
      expect(() => assertProjectPath(input, root)).toThrow();
      expect(() => validateProjectPath(input, root)).toThrow();
    },
  );

  it('maps a CRLF/Unicode byte range without leaking adjacent source', () => {
    const root = tempProject('projectmind-regression-range-');
    const file = join(root, 'src', 'unicode.ts');
    writeFileSync(file, 'const label = "🙂";\r\nconst next = true;\r\n', 'utf8');
    const content = Buffer.from('const label = "🙂";\r\n', 'utf8');
    const result = readSourceRange('src/unicode.ts', root, 0, content.length);
    expect(result.content).toBe('const label = "🙂";\r\n');
    expect(result.lineEnding).toBe('crlf');
    expect(result.endByte).toBe(content.length);
    expect(result.content).not.toContain('const next');
  });

  it('refuses an AST edit after the source hash becomes stale', () => {
    const root = tempProject('projectmind-regression-edit-');
    const file = join(root, 'src', 'value.ts');
    writeFileSync(file, 'export const value = 1;\n', 'utf8');
    const plan = makeSurgicalEditPlan('src/value.ts', root, 20, 21, '2', 'NumericLiteral');
    writeFileSync(file, 'export const value = 3;\n', 'utf8');
    const result = applySurgicalEdit(plan, root, { apply: true });
    expect(result.applied).toBe(false);
    expect(result.reason).toBe('stale-source-hash');
    expect(result.filePath).toBe(file);
  });

  it('marks non-search benchmark cases unknown instead of scoring a false lexical result', () => {
    const root = tempProject('projectmind-regression-benchmark-');
    writeFileSync(join(root, 'src', 'auth.ts'), 'export const auth = true;\n', 'utf8');
    const manifest = parseBenchmarkManifest({
      version: 1,
      name: 'regression',
      license: 'MIT',
      access: 'fixture',
      cases: [
        {
          id: 'impact-case',
          kind: 'impact',
          query: 'auth',
          expectedPaths: ['src/auth.ts'],
        },
      ],
    });
    const result = runBenchmark(manifest, root);
    expect(result.aggregate.evaluatedCases).toBe(0);
    expect(result.limitations[0]).toContain('impact evaluator');
  });

  it('detects duplicate ProjectMind config keys before JSON parsing hides them', () => {
    const root = tempProject('projectmind-regression-config-');
    const config = join(root, 'claude.json');
    writeFileSync(
      config,
      '{"mcpServers":{"projectmind":{"command":"npx","args":["mcp"]},"projectmind":{"command":"npx","args":["mcp"]}}}',
      'utf8',
    );
    const result = verifyMcpConfig(config, root, 'claude');
    expect(result.duplicateProjectMindEntries).toBe(1);
    expect(result.checks.find((check) => check.name === 'duplicate-entry')?.status).toBe('warn');
  });
});
