import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertProjectPath, validateProjectPath } from '../../src/core/security/path-security.js';
import { readSourceRange } from '../../src/core/retrieval/byte-range.js';
import { makeSurgicalEditPlan, applySurgicalEdit } from '../../src/core/refactor/surgical-edit.js';
import { parseBenchmarkManifest } from '../../scripts/benchmark/manifest.mjs';
import { runBenchmark } from '../../scripts/benchmark/runner.mjs';
import { verifyMcpConfig } from '../../src/cli/commands/init-mcp-config.js';

function tempProject(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, 'src'));
  return root;
}

describe('roadmap regression corpus', () => {
  it('keeps the core package install free of native optional dependency pulls', () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      scripts?: Record<string, unknown>;
      optionalDependencies?: Record<string, unknown>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    };
    expect(packageJson.scripts?.prepare).toBeUndefined();
    expect(packageJson.optionalDependencies).toBeUndefined();
    expect(packageJson.peerDependenciesMeta?.['@huggingface/transformers']?.optional).toBe(true);
    expect(packageJson.peerDependenciesMeta?.['onnxruntime-node']?.optional).toBe(true);
  });

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

  it('evaluates non-search benchmark cases with an explicit static limitation', () => {
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
    expect(result.aggregate.evaluatedCases).toBe(1);
    expect(result.scores[0]?.recallAtK).toBe(0);
    expect(result.limitations.join(' ')).toContain('statically parsed relative imports');
  });

  it('detects duplicate ProjectMind config keys before JSON parsing hides them', () => {
    const root = tempProject('projectmind-regression-config-');
    const config = join(root, 'claude.json');
    writeFileSync(
      config,
      '{"mcpServers":{"projectmind":{"command":"npx","args":["mcp"]},"projectmind":{"command":"npx","args":["mcp"]}}}',
      'utf8',
    );
    const result = verifyMcpConfig(config, root, 'json-mcp');
    expect(result.duplicateProjectMindEntries).toBe(1);
    expect(result.checks.find((check) => check.name === 'duplicate-entry')?.status).toBe('warn');
  });
});
