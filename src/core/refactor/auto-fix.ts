import ts from 'typescript';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Auto-Fix Engine v1 — AST-based mechanical fixes with diff preview.
 *
 * Philosophy: only fixes that are syntactically unambiguous and reversible
 * through the printed diff. Every fix runs against the real TypeScript AST
 * (no regex surgery on code), defaults to PREVIEW ONLY, and returns a
 * line-diff the caller (agent or human) can approve before writing.
 *
 * v1 fixers:
 *   organize-imports        — external-before-relative, alphabetical,
 *                             comments travel with their import
 *   dedupe-imports          — merges duplicate module specifiers into one
 *                             import with unioned named bindings
 *   remove-unused-imports   — drops imported bindings never referenced
 *                             anywhere else in the file (identifier-level,
 *                             includes type positions)
 */

export interface FixerMeta {
  id: string;
  description: string;
}

export interface AutoFixResult {
  filePath: string;
  fixer: string;
  changed: boolean;
  /** Unified-style line diff (present only when changed). */
  diff?: string;
  written: boolean;
  reason?: string;
}

const FIXERS: FixerMeta[] = [
  { id: 'organize-imports', description: 'Sort imports: externals before relatives, alphabetical; comments preserved' },
  { id: 'dedupe-imports', description: 'Merge duplicate import statements from the same module' },
  { id: 'remove-unused-imports', description: 'Remove imported bindings with zero references elsewhere in the file' },
];

interface ImportEntry {
  moduleSpecifier: string;
  isExternal: boolean;
  /** Full-text start incl. leading trivia (comments stay attached). */
  fullStart: number;
  start: number;
  end: number;
  defaultName: string | null;
  namespaceName: string | null;
  namedSpecifiers: string[]; // raw clause strings, e.g. "foo as f"
}

function collectImports(sf: ts.SourceFile): ImportEntry[] {
  const out: ImportEntry[] = [];
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const mod = stmt.moduleSpecifier;
    if (!ts.isStringLiteral(mod)) continue;
    const entry: ImportEntry = {
      fullStart: stmt.getFullStart(),
      start: stmt.getStart(sf),
      end: stmt.end,
      moduleSpecifier: mod.text,
      isExternal: !mod.text.startsWith('.'),
      defaultName: null,
      namespaceName: null,
      namedSpecifiers: [],
    };
    const clause = stmt.importClause;
    if (clause) {
      if (clause.name) entry.defaultName = clause.name.text;
      const named = clause.namedBindings;
      if (named && ts.isNamespaceImport(named)) {
        entry.namespaceName = named.name.text;
      } else if (named && ts.isNamedImports(named)) {
        for (const el of named.elements) {
          entry.namedSpecifiers.push(el.getText(sf));
        }
      }
    }
    out.push(entry);
  }
  return out;
}

function renderImport(entry: Pick<ImportEntry, 'defaultName' | 'namespaceName' | 'namedSpecifiers' | 'moduleSpecifier'>): string {
  // Side-effect-only import (no bindings at all).
  if (!entry.defaultName && !entry.namespaceName && entry.namedSpecifiers.length === 0) {
    return `import '${entry.moduleSpecifier}';`;
  }
  const parts: string[] = [];
  if (entry.defaultName) parts.push(entry.defaultName);
  if (entry.namespaceName) parts.push(`* as ${entry.namespaceName}`);
  if (entry.namedSpecifiers.length > 0) parts.push(`{ ${entry.namedSpecifiers.join(', ')} }`);
  return `import ${parts.join(', ')} from '${entry.moduleSpecifier}';`;
}

/** Local binding name of a named-import clause element ("foo as f" -> f). */
function localBindingName(specifier: string): string {
  const raw = specifier.includes(' as ') ? specifier.split(' as ').pop()!.trim() : specifier.trim();
  return raw.replace(/^type\s+/, '');
}

/**
 * Line diff via common prefix/suffix trimming — one replaced hunk with
 * context. Adequate (and honest) for mechanical single-region fixes.
 */
export function makeLineDiff(oldText: string, newText: string, contextLines = 2): string {
  if (oldText === newText) return '';
  const a = oldText.split('\n');
  const b = newText.split('\n');

  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }

  const removed = a.slice(prefix, a.length - suffix);
  const added = b.slice(prefix, b.length - suffix);

  const ctxHead = a.slice(Math.max(0, prefix - contextLines), prefix);
  const ctxTail = a.slice(a.length - suffix, Math.min(a.length - suffix + contextLines, a.length));

  return [
    `@@ -${prefix + 1},${removed.length} +${prefix + 1},${added.length} @@`,
    ...ctxHead.map((l) => `  ${l}`),
    ...removed.map((l) => `- ${l}`),
    ...added.map((l) => `+ ${l}`),
    ...ctxTail.map((l) => `  ${l}`),
  ].join('\n');
}

export class AutoFixEngine {
  constructor(private readonly projectRoot: string = process.cwd()) {}

  listFixers(): FixerMeta[] {
    return [...FIXERS];
  }

  /**
   * Run fixer(s) against a file. Writes to disk ONLY when opts.write is
   * true; otherwise the result carries the diff for approval.
   */
  run(fixerId: string, filePath: string, opts: { write?: boolean } = {}): AutoFixResult {
    const meta = FIXERS.find((f) => f.id === fixerId);
    if (!meta && fixerId !== 'all') {
      throw new Error(`Unknown fixer '${fixerId}'. Available: ${FIXERS.map((f) => f.id).join(', ')}, all`);
    }

    const abs = resolve(this.projectRoot, filePath);
    const original = readFileSync(abs, 'utf-8');
    const ids = meta ? [meta.id] : FIXERS.map((f) => f.id);

    let current = original;
    for (const id of ids) {
      current = this.applyOne(id, current, abs);
    }

    const changed = current !== original;
    const diff = changed ? makeLineDiff(original, current) : undefined;

    if (changed && opts.write) {
      writeFileSync(abs, current);
    }

    return {
      filePath: abs,
      fixer: ids.length > 1 ? 'all' : ids[0],
      changed,
      diff,
      written: changed && !!opts.write,
      ...(changed
        ? {}
        : { reason: 'nothing to do' }),
      ...(changed && !opts.write ? { reason: 'preview-only: re-run with write:true / --apply to persist' } : {}),
    };
  }

  private applyOne(fixerId: string, content: string, absPath: string): string {
    const sf = ts.createSourceFile(absPath, content, ts.ScriptTarget.Latest, /*setParentNodes*/ false);
    const imports = collectImports(sf);

    if (imports.length === 0) return content;

    // Guard: imports must form a leading block so rebuilding the region
    // cannot reorder code around interleaved statements.
    const firstFullStart = Math.min(...imports.map((i) => i.fullStart));
    const beforeBlock = content.slice(0, firstFullStart);
    if (/[^\s;]/.test(beforeBlock.replace(/^#![^\n]*/, ''))) {
      // Code/shebang precedes the first import — only safe when it's just
      // comments. Anything else → bail honestly.
      const stripped = beforeBlock.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      if (/[^\s;]/.test(stripped)) return content;
    }
    const lastEnd = Math.max(...imports.map((i) => i.end));

    switch (fixerId) {
      case 'organize-imports': {
        const sorted = [...imports].sort((x, y) => {
          if (x.isExternal !== y.isExternal) return x.isExternal ? -1 : 1;
          return x.moduleSpecifier.localeCompare(y.moduleSpecifier) || x.start - y.start;
        });
        const sameOrder = sorted.every((s, i) => s.start === imports[i].start);
        if (sameOrder) return content;
        const block = sorted
          .map((s) => content.slice(s.fullStart, s.end).trimEnd())
          .join('\n');
        return content.slice(0, firstFullStart) + block + content.slice(lastEnd);
      }

      case 'dedupe-imports': {
        const byModule = new Map<string, ImportEntry>();
        let sawDuplicate = false;
        for (const imp of imports) {
          const existing = byModule.get(imp.moduleSpecifier);
          if (!existing) {
            byModule.set(imp.moduleSpecifier, { ...imp });
            continue;
          }
          sawDuplicate = true;
          existing.defaultName = existing.defaultName ?? imp.defaultName;
          existing.namespaceName = existing.namespaceName ?? imp.namespaceName;
          const seen = new Set(existing.namedSpecifiers);
          for (const spec of imp.namedSpecifiers) {
            if (!seen.has(spec)) {
              existing.namedSpecifiers.push(spec);
              seen.add(spec);
            }
          }
        }
        if (!sawDuplicate) return content;

        const kept = [...byModule.values()];
        kept.sort((a, b) =>
          a.isExternal === b.isExternal ? a.moduleSpecifier.localeCompare(b.moduleSpecifier) : a.isExternal ? -1 : 1
        );
        const block = kept.map(renderImport).join('\n');
        return content.slice(0, firstFullStart) + block + content.slice(lastEnd);
      }

      case 'remove-unused-imports': {
        // Identifiers used anywhere outside import declarations.
        const used = new Set<string>();
        const visitOutsideImports = (nodes: readonly ts.Node[]): void => {
          for (const node of nodes) {
            if (ts.isImportDeclaration(node)) continue;
            const walk = (n: ts.Node): void => {
              if (ts.isIdentifier(n)) used.add(n.text);
              ts.forEachChild(n, walk);
            };
            walk(node);
          }
        };
        visitOutsideImports(sf.statements);

        const survivors: string[] = [];
        let removedAny = false;
        for (const imp of imports) {
          const keepDefault = !!imp.defaultName && used.has(imp.defaultName);
          const keepNs = !!imp.namespaceName && used.has(imp.namespaceName);
          const named = imp.namedSpecifiers.filter((spec) => used.has(localBindingName(spec)));
          if ((imp.defaultName && !keepDefault) || (imp.namespaceName && !keepNs) || named.length !== imp.namedSpecifiers.length) {
            removedAny = true;
          }
          const next = { ...imp, defaultName: keepDefault ? imp.defaultName : null, namespaceName: keepNs ? imp.namespaceName : null, namedSpecifiers: named };
          const empty = !next.defaultName && !next.namespaceName && next.namedSpecifiers.length === 0;
          if (empty) continue; // drop entire import line
          survivors.push(renderImport(next));
        }
        if (!removedAny) return content;
        return content.slice(0, firstFullStart) + survivors.join('\n') + content.slice(lastEnd);
      }

      default:
        return content;
    }
  }
}
