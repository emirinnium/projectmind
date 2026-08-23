import ts from 'typescript';
import { readFileSync, writeFileSync } from 'node:fs';
import { logger } from '../utils/logger.js';

export interface StructuralMatch {
  filePath: string;
  startLine: number;
  endLine: number;
  startOffset: number;
  endOffset: number;
  nodeKind: string;
  text: string;
  replacement?: string;
}

export interface StructuralSearchOptions {
  filePatterns?: string[];
  nodeKind?: string;
  hasModifier?: string;
  containsText?: string;
  namePattern?: string;
  maxResults?: number;
}

export interface StructuralReplaceOptions extends StructuralSearchOptions {
  replacement: string;
  dryRun?: boolean;
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
 * Structural Search: Find AST nodes matching a pattern across the codebase
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
        const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);

        const visit = (node: ts.Node) => {
          if (results.length >= maxResults) return;

          if (this.matchesNode(node, options)) {
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
   * Replace matching AST nodes with new code
   */
  replace(options: StructuralReplaceOptions, filePaths: string[]): { replaced: number; files: string[]; dryRun: boolean } {
    const replaced: string[] = [];
    let count = 0;

    for (const filePath of filePaths) {
      try {
        const content = readFileSync(filePath, 'utf-8');
        const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);

        const matches = this.findMatches(sourceFile, options);
        if (matches.length === 0) continue;

        // Sort matches by offset in reverse order to preserve positions
        matches.sort((a, b) => b.startOffset - a.startOffset);

        let newContent = content;
        for (const match of matches) {
          newContent = newContent.substring(0, match.startOffset) + options.replacement + newContent.substring(match.endOffset);
          count++;
        }

        if (!options.dryRun) {
          writeFileSync(filePath, newContent);
        }

        replaced.push(filePath);
      } catch {
        // Skip files that can't be processed (write errors, encoding issues)
        logger.debug(`Skipping file in structural replace: ${filePath}`);
      }
    }

    return { replaced: count, files: replaced, dryRun: options.dryRun ?? false };
  }

  private findMatches(sourceFile: ts.SourceFile, options: StructuralReplaceOptions): StructuralMatch[] {
    const matches: StructuralMatch[] = [];

    const visit = (node: ts.Node) => {
      if (this.matchesNode(node, options)) {
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
        });
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    return matches;
  }

  private matchesNode(node: ts.Node, options: StructuralSearchOptions): boolean {
    // Match by node kind
    if (options.nodeKind && ts.SyntaxKind[node.kind] !== options.nodeKind) {
      return false;
    }

    // Match by modifier. Accept friendly names ('async', 'export', ...) and
    // map them to TS SyntaxKind names ('AsyncKeyword', ...); raw kind names
    // still work as pass-through. Previously '-m async' could never match,
    // silently breaking the documented usage.
    if (options.hasModifier) {
      const wanted = MODIFIER_ALIASES[options.hasModifier.toLowerCase()] ?? options.hasModifier;
      const hasMods = ts.canHaveModifiers(node);
      const modifiers = hasMods ? ts.getModifiers(node) : undefined;
      if (!modifiers || !Array.from(modifiers).some((m) => ts.SyntaxKind[m.kind] === wanted)) {
        return false;
      }
    }

    // Match by name pattern (functions, classes, etc.)
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
}
