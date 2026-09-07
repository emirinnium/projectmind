import ts from 'typescript';
import { readFileSync, writeFileSync } from 'node:fs';
import { logger } from '../utils/logger.js';
import { detectLanguageFromPath, type StructuralLanguage } from './language-service.js';

export interface StructuralMatch {
  filePath: string;
  startLine: number;
  endLine: number;
  startOffset: number;
  endOffset: number;
  nodeKind: string;
  text: string;
  replacement?: string;
  language: StructuralLanguage;
}

export interface StructuralSearchOptions {
  filePatterns?: string[];
  nodeKind?: string;
  hasModifier?: string;
  containsText?: string;
  namePattern?: string;
  maxResults?: number;
  language?: StructuralLanguage;
}

export interface StructuralReplaceOptions extends StructuralSearchOptions {
  replacement: string;
  dryRun?: boolean;
}

/**
 * Before/after content pair for a single file replacement.
 * Returned for every modified file so callers (MCP tools, CLI) can present
 * diffs without touching disk — critical for dry-run previews.
 */
export interface FileDiff {
  filePath: string;
  original: string;
  transformed: string;
}

/** Friendly modifier names -> TS SyntaxKind names (pass-through for exact names). */
const MODIFIER_ALIASES: Record<string, string> = {
  async: 'AsyncKeyword',
  export: 'ExportKeyword',
  default: 'DefaultKeyword',
  static: 'StaticKeyword',
  public: 'PublicKeyword',
  private: 'PrivateKeyword',
  protected: 'ProtectedKeyword',
  readonly: 'ReadonlyKeyword',
  abstract: 'AbstractKeyword',
};

/**
 * Structural Search: Find TypeScript/JavaScript AST nodes matching a pattern
 * across the codebase.
 */
export class StructuralSearcher {
  /**
   * Search for AST nodes matching the given criteria
   */
  search(options: StructuralSearchOptions, filePaths: string[]): StructuralMatch[] {
    const results: StructuralMatch[] = [];
    const maxResults = options.maxResults || 50;

    for (const filePath of filePaths) {
      if (results.length >= maxResults) break;

      try {
        const content = readFileSync(filePath, 'utf-8');
        const language = options.language ?? detectLanguageFromPath(filePath);
        if (!language) continue;
        const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);

        const visit = (node: ts.Node) => {
          if (results.length >= maxResults) return;

          if (this.matchesTypeScriptNode(node, options)) {
            const start = node.getStart(sourceFile);
            const end = node.getEnd();
            const text = content.substring(start, end);

            results.push({
              filePath,
              startLine: sourceFile.getLineAndCharacterOfPosition(start).line + 1,
              endLine: sourceFile.getLineAndCharacterOfPosition(end).line + 1,
              startOffset: start,
              endOffset: end,
              nodeKind: ts.SyntaxKind[node.kind],
              text,
              language,
            });
          }

          ts.forEachChild(node, visit);
        };

        visit(sourceFile);
      } catch {
        // Skip files that can't be parsed (syntax errors, encoding issues)
        logger.debug(`Skipping file in structural search: ${filePath}`);
      }
    }

    return results;
  }

  /**
   * Replace matching AST nodes with new code.
   *
   * Uses the TypeScript Compiler API to **discover** matched nodes (by kind,
   * modifier, name pattern, and contained text), then applies replacements
   * as text-level splices on the original source string.
   *
   * This hybrid approach gives us AST-precision for node discovery while
   * avoiding the `pos`/`end` corruption that `ts.transform` + `printFile`
   * introduces when transplanting nodes between synthetic and real source files.
   *
   * Before applying a splice, the replacement text is validated by parsing it
   * into a compatible AST node (expression ↔ expression, statement ↔ statement)
   * to catch syntax errors early.
   *
   * When `dryRun` is true, no files are written; the caller receives full
   * before/after diffs in the `diffs` array.
   */
  replace(
    options: StructuralReplaceOptions,
    filePaths: string[],
  ): { replaced: number; files: string[]; dryRun: boolean; diffs: FileDiff[] } {
    const replaced: string[] = [];
    const diffs: FileDiff[] = [];
    let count = 0;

    for (const filePath of filePaths) {
      try {
        const content = readFileSync(filePath, 'utf-8');
        const language = options.language ?? detectLanguageFromPath(filePath);
        if (!language) continue;

        const applySplices = (matches: StructuralMatch[]): { next: string; applied: number } => {
          // Apply splices in reverse position order so that earlier offsets
          // remain valid as we modify the string.
          const sorted = [...matches].sort((a, b) => b.startOffset - a.startOffset);
          let next = content;
          for (const match of sorted) {
            next =
              next.substring(0, match.startOffset) +
              options.replacement +
              next.substring(match.endOffset);
          }
          return { next, applied: matches.length };
        };

        const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);

        // Collect matches with their positions.
        const matches = this.findMatches(sourceFile, options);
        if (matches.length === 0) continue;

        // Validate that the replacement text can be parsed as a compatible node.
        // Use the first match to determine node compatibility.
        const firstMatchNode = this.findFirstMatchNode(sourceFile, matches[0]);
        if (firstMatchNode && !this.parseReplacementForNode(options.replacement, firstMatchNode)) {
          // Replacement text is not valid for the matched node type — skip this file.
          continue;
        }

        const { next: newContent, applied } = applySplices(matches);

        if (newContent !== content) {
          diffs.push({ filePath, original: content, transformed: newContent });
          if (!options.dryRun) {
            writeFileSync(filePath, newContent);
          }
          replaced.push(filePath);
          count += applied;
        }
      } catch {
        // Skip files that can't be processed (write errors, encoding issues)
        logger.debug(`Skipping file in structural replace: ${filePath}`);
      }
    }

    return { replaced: count, files: replaced, dryRun: options.dryRun ?? false, diffs };
  }

  /**
   * Locate the actual AST node for a given match so we can determine
   * whether the replacement text is syntactically compatible.
   */
  private findFirstMatchNode(
    sourceFile: ts.SourceFile,
    match: StructuralMatch,
  ): ts.Node | undefined {
    let found: ts.Node | undefined;
    const visit = (node: ts.Node) => {
      if (found) return;
      const start = node.getStart(sourceFile);
      const end = node.getEnd();
      if (start === match.startOffset && end === match.endOffset) {
        found = node;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return found;
  }

  private findMatches(
    sourceFile: ts.SourceFile,
    options: StructuralReplaceOptions,
  ): StructuralMatch[] {
    const matches: StructuralMatch[] = [];
    const language =
      options.language ?? detectLanguageFromPath(sourceFile.fileName) ?? 'typescript';

    const visit = (node: ts.Node) => {
      if (this.matchesTypeScriptNode(node, options)) {
        const start = node.getStart(sourceFile);
        const end = node.getEnd();
        matches.push({
          filePath: sourceFile.fileName,
          startLine: sourceFile.getLineAndCharacterOfPosition(start).line + 1,
          endLine: sourceFile.getLineAndCharacterOfPosition(end).line + 1,
          startOffset: start,
          endOffset: end,
          nodeKind: ts.SyntaxKind[node.kind],
          text: sourceFile.text.substring(start, end),
          language,
        });
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    return matches;
  }

  private matchesTypeScriptNode(node: ts.Node, options: StructuralSearchOptions): boolean {
    // Match by node kind
    if (options.nodeKind && ts.SyntaxKind[node.kind] !== options.nodeKind) {
      return false;
    }

    // Match by modifier
    if (options.hasModifier) {
      const wanted = MODIFIER_ALIASES[options.hasModifier.toLowerCase()] ?? options.hasModifier;
      const hasMods = ts.canHaveModifiers(node);
      const modifiers = hasMods ? ts.getModifiers(node) : undefined;
      if (!modifiers || !Array.from(modifiers).some((m) => ts.SyntaxKind[m.kind] === wanted)) {
        return false;
      }
    }

    // Match by name pattern
    if (options.namePattern) {
      const named = node as ts.NamedDeclaration;
      const name = named.name?.getText ? named.name.getText() : undefined;
      if (!name || !new RegExp(options.namePattern).test(name)) {
        return false;
      }
    }

    // Match by contained text
    if (options.containsText) {
      const text = node.getText();
      if (!text.includes(options.containsText)) {
        return false;
      }
    }

    return true;
  }

  // ---------------------------------------------------------------------------
  // AST-based replacement helpers
  //
  // The `replacement` string supplied by the caller is parsed into a valid
  // TypeScript AST node that is type-compatible with the matched node. This
  // preserves surrounding code structure (indentation, adjacent nodes, syntax
  // context) — something substring replacement cannot guarantee.
  // ---------------------------------------------------------------------------

  /**
   * Parse `replacement` into a node compatible with `targetNode`.
   *
   * Strategy:
   *  1. If `targetNode` is an expression → parse as expression.
   *  2. If `targetNode` is a statement or declaration → parse as statement.
   *  3. Fallback: try expression (covers identifiers, literals, calls, etc.).
   */
  private parseReplacementForNode(replacement: string, targetNode: ts.Node): ts.Node | undefined {
    if (ts.isExpression(targetNode)) {
      return this.parseAsExpression(replacement);
    }
    if (ts.isStatement(targetNode) || this.isDeclarationNode(targetNode)) {
      return this.parseAsStatementOrDeclaration(replacement);
    }
    // Identifier / TypeNode / etc. — try expression (most flexible).
    return this.parseAsExpression(replacement);
  }

  /**
   * Parse `text` as a TypeScript expression.
   *
   * Wraps the text in a variable initializer (`const __pm_r = <text>;`),
   * parses, and extracts the initializer expression. Returns `undefined`
   * when `text` is not a valid expression or when the parser produces
   * error-recovery nodes.
   */
  private parseAsExpression(text: string): ts.Expression | undefined {
    try {
      const wrapped = `const __pm_r = ${text};`;
      const sf = ts.createSourceFile('__pm_replace.ts', wrapped, ts.ScriptTarget.Latest, true);
      // `parseDiagnostics` exists on SourceFile at runtime but is not in the
      // TypeScript type declarations.  Access it via a narrow type assertion
      // to reject error-recovery ASTs produced by invalid syntax.
      if ((sf as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics?.length)
        return undefined;
      const stmt = sf.statements[0];
      if (ts.isVariableStatement(stmt)) {
        const decl = stmt.declarationList.declarations[0];
        if (decl?.initializer && ts.isExpression(decl.initializer)) {
          return decl.initializer;
        }
      }
    } catch {
      // Not a valid expression.
    }
    return undefined;
  }

  /**
   * Parse `text` as a TypeScript statement or declaration.
   *
   * Returns the first top-level statement from a synthetic source file.
   * Returns `undefined` when `text` is not valid statement-level code or
   * when the parser produces error-recovery nodes.
   */
  private parseAsStatementOrDeclaration(text: string): ts.Statement | undefined {
    try {
      const sf = ts.createSourceFile('__pm_replace.ts', text, ts.ScriptTarget.Latest, true);
      // Reject if parser produced diagnostics (syntax errors / error-recovery nodes).
      if ((sf as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics?.length)
        return undefined;
      if (sf.statements.length > 0) {
        return sf.statements[0];
      }
    } catch {
      // Not a valid statement.
    }
    return undefined;
  }

  /**
   * Check whether a node is a declaration (function, class, variable, etc.).
   * `ts.isDeclaration` is not available in all TS versions, so we check the
   * kind range manually.
   */
  private isDeclarationNode(node: ts.Node): boolean {
    const k = node.kind;
    return (
      (k >= ts.SyntaxKind.FunctionDeclaration && k <= ts.SyntaxKind.VariableDeclaration) ||
      k === ts.SyntaxKind.ClassDeclaration ||
      k === ts.SyntaxKind.InterfaceDeclaration ||
      k === ts.SyntaxKind.TypeAliasDeclaration ||
      k === ts.SyntaxKind.EnumDeclaration ||
      k === ts.SyntaxKind.ModuleDeclaration ||
      k === ts.SyntaxKind.ImportDeclaration ||
      k === ts.SyntaxKind.ExportDeclaration ||
      k === ts.SyntaxKind.ExportAssignment
    );
  }
}
