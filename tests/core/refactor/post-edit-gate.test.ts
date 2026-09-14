import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runPostEditGate } from '../../../src/core/refactor/post-edit-gate.js';

describe('post-edit semantic gate', () => {
  const roots: string[] = [];

  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  function makeFile(): { root: string; filePath: string } {
    const root = mkdtempSync(join(tmpdir(), 'projectmind-gate-'));
    const filePath = join(root, 'src', 'value.ts');
    roots.push(root);
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(filePath, '');
    return { root, filePath };
  }

  it('passes a behavior-preserving edit and reports every gate', () => {
    const { root, filePath } = makeFile();
    const report = runPostEditGate({
      projectRoot: root,
      filePath,
      before: 'export const value = 1;\n',
      after: 'export const value = 2;\n',
    });

    expect(report.passed).toBe(true);
    expect(report.checks.map((check) => check.id)).toEqual([
      'parse',
      'coherence',
      'impact',
      'typecheck',
      'contract',
    ]);
    expect(report.checks.every((check) => check.status !== 'fail')).toBe(true);
  });

  it('rejects edits that introduce a contract violation', () => {
    const { root, filePath } = makeFile();
    const report = runPostEditGate({
      projectRoot: root,
      filePath,
      before: 'export const value = 1;\n',
      after: 'export const value = eval("1");\n',
    });

    expect(report.passed).toBe(false);
    expect(report.newContractErrors).toHaveLength(1);
    expect(report.checks.find((check) => check.id === 'contract')?.status).toBe('fail');
  });

  it('rejects syntactically invalid edits before they can be written', () => {
    const { root, filePath } = makeFile();
    const report = runPostEditGate({
      projectRoot: root,
      filePath,
      before: 'export const value = 1;\n',
      after: 'export const value = ;\n',
    });

    expect(report.passed).toBe(false);
    expect(report.checks.find((check) => check.id === 'parse')?.status).toBe('fail');
  });

  it('surfaces public API changes as an explicit impact warning', () => {
    const { root, filePath } = makeFile();
    const report = runPostEditGate({
      projectRoot: root,
      filePath,
      before: 'export const value = 1;\n',
      after: 'export const value = 1;\nexport function read() { return value; }\n',
    });

    expect(report.passed).toBe(true);
    expect(report.publicApiChanged).toBe(true);
    expect(report.checks.find((check) => check.id === 'impact')?.status).toBe('warn');
  });
});
