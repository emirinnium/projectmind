import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { relative, resolve } from 'node:path';

/**
 * AST-based clone detector (Type-2) v1.
 *
 * Two functions are clones when their bodies are IDENTICAL after renaming
 * every locally-declared binding to a positional placeholder. This catches
 * copy-paste-with-rename duplicates that line-diff or debt heuristics miss,
 * while keeping behavior-relevant tokens (member/method names, literals,
 * keywords) untouched.
 *
 * Honest scope:
 * - Function-like units only (functions, methods, arrow fns assigned to
 *   consts). Whole-file / class-shape cloning is out of scope for v1.
 * - Exact-normalized matching only (no near-miss scoring yet).
 * - Linear pass over candidate files; fine up to a few thousand files.
 */

export interface CloneOccurrence {
  filePath: string; // project-relative
  name: string;
  startLine: number;
  endLine: number;
}

export interface CloneGroup {
  fingerprint: string;
  size: number;
  /** Approximate body length in lines of the first occurrence. */
  approxLines: number;
  occurrences: CloneOccurrence[];
}

export interface CloneDetectionOptions {
  minLines?: number; // ignore smaller bodies (default 6)
  maxFiles?: number; // safety cap (default 3000)
  maxGroups?: number; // report cap (default 50)
}

interface FnUnit {
  file: string;
  name: string;
  start: number;
  end: number;
  bodyStart: number;
  bodyEnd: number;
  source: ts.SourceFile;
  node: ts.Node & { body?: ts.Node };
}

/** Names declared as parameters or local variables within a function subtree. */
function collectDeclaredNames(fn: ts.Node): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
      names.add(node.name.text);
    } else if (ts.isVariableDeclaration(node)) {
      if (ts.isIdentifier(node.name)) {
        names.add(node.name.text);
      }
    } else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name && node !== fn) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn, visit);
  return names;
}

/**
 * Normalize a function body: replace locally-declared identifiers with
 * positional placeholders so two renamed copies produce identical text.
 */
function normalizeBody(bodyText: string, declaredNames: Set<string>): string {
  return bodyText.replace(/\b[A-Za-z_$][\w$]*\b/g, (ident) => (declaredNames.has(ident) ? '_ID' : ident));
}

function* walkFunctionLike(sf: ts.SourceFile): Generator<{ node: ts.Node & { body?: ts.Node }; name: string }> {
  // Recursive collector flattened into a generator (no delegation needed).
  const found: Array<{ node: ts.Node & { body?: ts.Node }; name: string }> = [];
  const collect = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) found.push({ node, name: node.name.text });
    else if (ts.isMethodDeclaration(node) && node.name && !ts.isComputedPropertyName(node.name))
      found.push({ node, name: node.name.getText(sf) });
    else if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer && ts.isArrowFunction(decl.initializer)) {
          found.push({ node: decl.initializer as ts.Node & { body?: ts.Node }, name: decl.name.text });
        }
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);
  yield* found;
}

export interface CloneDetectionResult {
  scannedFiles: number;
  scannedFunctions: number;
  groups: CloneGroup[];
  note: string;
}

export class CloneDetector {
  constructor(private readonly projectRoot: string = process.cwd()) {}

  /**
   * Detect clone groups across the given absolute/relative file paths.
   */
  detect(filePaths: string[], options: CloneDetectionOptions = {}): CloneDetectionResult {
    const minLines = Math.max(3, options.minLines ?? 6);
    const maxFiles = Math.max(1, options.maxFiles ?? 3000);
    const maxGroups = Math.max(1, options.maxGroups ?? 50);

    // Dedupe input paths: KG indexes may contain duplicate rows for the
    // same file (multi-project history), which would fake "2x" groups.
    const files = [...new Set(filePaths.map((p) => p.split('\\').join('/')))].slice(0, maxFiles);
    const buckets = new Map<string, CloneOccurrence[]>();
    const bucketLines = new Map<string, number>();

    let scannedFunctions = 0;

    for (const relPath of files) {
      const abs = resolve(this.projectRoot, relPath);
      let content: string;
      try {
        content = readFileSync(abs, 'utf-8');
      } catch {
        continue;
      }
      if (!/\.[cm]?[jt]sx?$/i.test(relPath)) continue;
      const sf = ts.createSourceFile(abs, content, ts.ScriptTarget.Latest, /*setParentNodes*/ false);

      for (const unit of this.extractUnits(sf)) {
        scannedFunctions++;
        const bodyText = unit.source.text.slice(unit.bodyStart, unit.bodyEnd);
        const lineCount = bodyText.split(/\r?\n/).length;
        if (lineCount < minLines) continue;

        const declared = collectDeclaredNames(unit.node);
        const normalized = normalizeBody(bodyText, declared);
        const fp = createHash('sha256').update(normalized).digest('hex').slice(0, 16);

        let occs = buckets.get(fp);
        if (!occs) {
          occs = [];
          buckets.set(fp, occs);
          bucketLines.set(fp, lineCount);
        }
        occs.push({
          filePath: unit.file,
          name: unit.name,
          startLine: unit.start,
          endLine: unit.end,
        });
      }
    }

    const groups: CloneGroup[] = [];
    for (const [fp, occs] of buckets) {
      if (occs.length < 2) continue;
      groups.push({
        fingerprint: fp,
        size: occs.length,
        approxLines: bucketLines.get(fp) ?? 0,
        occurrences: occs.sort((a, b) => a.filePath.localeCompare(b.filePath)),
      });
    }
    groups.sort((a, b) => b.size * b.approxLines - a.size * a.approxLines);

    return {
      scannedFiles: files.length,
      scannedFunctions,
      groups: groups.slice(0, maxGroups),
      note: 'Type-2 clones: identical after local-renaming normalization. Larger (size x lines) groups first.',
    };
  }

  private extractUnits(sf: ts.SourceFile): Array<FnUnit> {
    const units: FnUnit[] = [];
    for (const { node, name } of walkFunctionLike(sf)) {
      const body = ts.isFunctionLike(node) ? node.body : undefined;
      if (!body) continue;
      units.push({
        file: relative(this.projectRoot, sf.fileName).split('\\').join('/'),
        name,
        start: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        end: sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
        bodyStart: body.getStart(sf),
        bodyEnd: body.getEnd(),
        source: sf,
        node,
      });
    }
    return units;
  }
}
