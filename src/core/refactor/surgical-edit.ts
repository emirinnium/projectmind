import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { assertProjectPath } from '../security/path-security.js';
import { writeFileAtomically } from '../../utils/atomic-write.js';
import { relative } from 'node:path';
import { runPostEditGate, type PostEditGateReport } from './post-edit-gate.js';

export interface SurgicalEditPlan {
  filePath: string;
  start: number;
  end: number;
  replacement: string;
  expectedText: string;
  expectedSourceHash: string;
  nodeKind?: string;
}

export interface SurgicalEditResult {
  applied: boolean;
  filePath: string;
  beforeHash: string;
  afterHash?: string;
  diff: string;
  rollbackPath?: string;
  reason?: string;
  gate?: PostEditGateReport;
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function simpleDiff(before: string, after: string): string {
  if (before === after) return '';
  return `--- before\n+++ after\n- ${before}\n+ ${after}`;
}

/**
 * Apply one source-anchored edit. The caller must explicitly opt into apply;
 * the default path only returns a diff. A source hash and exact anchor are
 * both required, preventing stale agents from writing at guessed offsets.
 */
export function applySurgicalEdit(
  plan: SurgicalEditPlan,
  projectRoot: string,
  options: { apply?: boolean; keepRollback?: boolean } = {},
): SurgicalEditResult {
  const absolutePath = assertProjectPath(plan.filePath, projectRoot, {
    mustExist: true,
    rejectIgnored: true,
  });
  const before = readFileSync(absolutePath, 'utf8');
  const beforeHash = hash(before);
  if (beforeHash !== plan.expectedSourceHash) {
    return {
      applied: false,
      filePath: absolutePath,
      beforeHash,
      diff: '',
      reason: 'stale-source-hash',
    };
  }
  if (plan.start < 0 || plan.end < plan.start || plan.end > before.length) {
    return {
      applied: false,
      filePath: absolutePath,
      beforeHash,
      diff: '',
      reason: 'invalid-edit-range',
    };
  }
  if (before.slice(plan.start, plan.end) !== plan.expectedText) {
    return {
      applied: false,
      filePath: absolutePath,
      beforeHash,
      diff: '',
      reason: 'anchor-mismatch',
    };
  }
  if (plan.nodeKind) {
    const requestedNodeKind = plan.nodeKind;
    const sourceFile = ts.createSourceFile(absolutePath, before, ts.ScriptTarget.Latest, true);
    let anchorFound = false;
    const visit = (node: ts.Node): void => {
      if (
        node.getStart(sourceFile) <= plan.start &&
        node.getEnd() >= plan.end &&
        nodeKindMatches(node, requestedNodeKind)
      ) {
        anchorFound = true;
      }
      if (!anchorFound) ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    if (!anchorFound) {
      return {
        applied: false,
        filePath: absolutePath,
        beforeHash,
        diff: '',
        reason: 'node-kind-anchor-mismatch',
      };
    }
  }
  const after = `${before.slice(0, plan.start)}${plan.replacement}${before.slice(plan.end)}`;
  const transpiled = ts.transpileModule(after, {
    fileName: absolutePath,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    reportDiagnostics: true,
  });
  if (
    (transpiled.diagnostics ?? []).some(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    )
  ) {
    return {
      applied: false,
      filePath: absolutePath,
      beforeHash,
      diff: '',
      reason: 'replacement-does-not-parse',
    };
  }
  const gate = runPostEditGate({
    projectRoot,
    filePath: relative(projectRoot, absolutePath),
    before,
    after,
  });
  if (!gate.passed) {
    return {
      applied: false,
      filePath: absolutePath,
      beforeHash,
      diff: '',
      reason: `post-edit-gate-failed: ${gate.checks
        .filter((check) => check.status === 'fail')
        .map((check) => check.id)
        .join(', ')}`,
      gate,
    };
  }
  const diff = simpleDiff(plan.expectedText, plan.replacement);
  if (!options.apply) {
    return {
      applied: false,
      filePath: absolutePath,
      beforeHash,
      diff,
      reason: 'preview-only',
      gate,
    };
  }

  const afterHash = hash(after);
  let rollbackPath: string | undefined;
  if (options.keepRollback !== false) {
    rollbackPath = `${absolutePath}.projectmind-rollback`;
    writeFileAtomically(rollbackPath, before);
  }
  writeFileAtomically(absolutePath, after);
  return { applied: true, filePath: absolutePath, beforeHash, afterHash, diff, rollbackPath, gate };
}

function nodeKindMatches(node: ts.Node, requested: string): boolean {
  if (ts.SyntaxKind[node.kind] === requested) return true;
  // TypeScript exposes some literal kinds through legacy enum aliases such
  // as FirstLiteralToken. Accept the public semantic names callers use.
  if (requested === 'NumericLiteral') return ts.isNumericLiteral(node);
  if (requested === 'StringLiteral') return ts.isStringLiteral(node);
  if (requested === 'NoSubstitutionTemplateLiteral')
    return ts.isNoSubstitutionTemplateLiteral(node);
  return false;
}

export function makeSurgicalEditPlan(
  filePath: string,
  projectRoot: string,
  start: number,
  end: number,
  replacement: string,
  nodeKind?: string,
): SurgicalEditPlan {
  const absolutePath = assertProjectPath(filePath, projectRoot, {
    mustExist: true,
    rejectIgnored: true,
  });
  const content = readFileSync(absolutePath, 'utf8');
  return {
    filePath,
    start,
    end,
    replacement,
    expectedText: content.slice(start, end),
    expectedSourceHash: hash(content),
    nodeKind,
  };
}
