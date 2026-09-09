import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  applySurgicalEdit,
  makeSurgicalEditPlan,
} from '../../../src/core/refactor/surgical-edit.js';

describe('source-anchored surgical edits', () => {
  it('previews without writing and applies atomically only with a fresh hash', () => {
    const root = mkdtempSync(join(tmpdir(), 'projectmind-edit-'));
    writeFileSync(join(root, 'value.ts'), 'export const value = 1;\n');
    const plan = makeSurgicalEditPlan('value.ts', root, 21, 22, '2', 'NumericLiteral');
    const preview = applySurgicalEdit(plan, root);
    expect(preview.applied).toBe(false);
    expect(preview.reason).toBe('preview-only');
    expect(readFileSync(join(root, 'value.ts'), 'utf8')).toContain('= 1');
    const applied = applySurgicalEdit(plan, root, { apply: true });
    expect(applied.applied).toBe(true);
    expect(applied.beforeHash).not.toBe(applied.afterHash);
    expect(readFileSync(join(root, 'value.ts'), 'utf8')).toContain('= 2');
  });

  it('does not write when the source hash is stale or replacement is invalid', () => {
    const root = mkdtempSync(join(tmpdir(), 'projectmind-edit-'));
    writeFileSync(join(root, 'value.ts'), 'export const value = 1;\n');
    const plan = makeSurgicalEditPlan('value.ts', root, 21, 22, '2');
    writeFileSync(join(root, 'value.ts'), 'export const value = 3;\n');
    expect(applySurgicalEdit(plan, root, { apply: true }).reason).toBe('stale-source-hash');
  });
});
