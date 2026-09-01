import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { Language, FileStructure, FunctionInfo, ClassInfo } from '../types.js';

/** JSON module import extensions recognized during parsing */
const JSON_EXTENSIONS = ['.json'];

function getModifiers(node: ts.Node): ts.Modifier[] {
  if (ts.canHaveModifiers(node)) {
    const mods = ts.getModifiers(node);
    if (mods) {
      return Array.from(mods);
    }
  }
  // Fallback for nodes that may store modifiers directly (older TS versions)
  const modifierLike =
    'modifiers' in node ? (node as { modifiers?: readonly ts.Modifier[] }).modifiers : undefined;
  if (modifierLike && Array.isArray(modifierLike)) {
    return Array.from(modifierLike);
  }
  return [];
}

function isAsync(node: ts.Node): boolean {
  const modifiers = getModifiers(node);
  return modifiers.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
}

function isExported(node: ts.Node): boolean {
  const modifiers = getModifiers(node);
  return modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function calculateCyclomaticComplexity(node: ts.Node): number {
  let complexity = 1;
  function visit(n: ts.Node) {
    if (ts.isIfStatement(n) || ts.isConditionalExpression(n)) complexity++;
    if (ts.isCaseClause(n) && !ts.isDefaultClause(n)) complexity++;
    if (ts.isForStatement(n) || ts.isForInStatement(n) || ts.isForOfStatement(n)) complexity++;
    if (ts.isWhileStatement(n) || ts.isDoStatement(n)) complexity++;
    if (
      ts.isBinaryExpression(n) &&
      (n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        n.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    )
      complexity++;
    ts.forEachChild(n, visit);
  }
  visit(node);
  return complexity;
}

export function parseTypeScriptFile(
  filePath: string,
  content?: string,
  language?: Language,
): FileStructure {
  const sourceText = content ?? readFileSync(filePath, 'utf-8');
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);

  const functions: FunctionInfo[] = [];
  const classes: ClassInfo[] = [];
  const imports: { source: string; named: string[]; kind: string }[] = [];
  const exports: string[] = [];

  const hash = createHash('sha256').update(sourceText).digest('hex');

  for (const node of sourceFile.statements) {
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
      const name = node.name?.getText() ?? 'anonymous';
      const fnIsAsync = isAsync(node);
      const fnIsExported = isExported(node) || ts.isExportAssignment(node);
      const params = node.parameters.map((p) => ({
        name: p.name?.getText() ?? '',
        type: p.type ? p.type.getText() : 'any',
      }));
      const sig = `${name}(${params.map((p) => `${p.name}: ${p.type}`).join(', ')})`;
      const retType = node.type ? node.type.getText() : 'void';
      functions.push({
        name,
        signature: sig,
        returnType: retType,
        startLine: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        endLine: sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
        complexity: 0,
        kind: ts.isMethodDeclaration(node) ? 'method' : 'function',
        parameters: params,
        isExported: fnIsExported,
        isAsync: fnIsAsync,
        cyclomaticComplexity: calculateCyclomaticComplexity(node),
      });
    }

    if (ts.isClassDeclaration(node)) {
      const name = node.name?.getText() ?? 'AnonymousClass';
      const extended = node.heritageClauses?.some((h) => h.token === ts.SyntaxKind.ExtendsKeyword)
        ? node.heritageClauses
            .filter((h) => h.token === ts.SyntaxKind.ExtendsKeyword)
            .map((h) => h.types[0]?.getText())
            .filter(Boolean)
            .join(', ')
        : null;
      const methodMembers = node.members.filter((m) => ts.isMethodDeclaration(m));
      const propertyMembers = node.members.filter((m) => ts.isPropertyDeclaration(m));
      const methods = methodMembers.map((m) => ({
        name: m.name?.getText() ?? 'anonymous',
        kind: 'method' as const,
        isStatic: m.modifiers?.some((mod) => mod.kind === ts.SyntaxKind.StaticKeyword) ?? false,
        accessModifier: m.modifiers?.some((mod) => mod.kind === ts.SyntaxKind.PrivateKeyword)
          ? 'private'
          : m.modifiers?.some((mod) => mod.kind === ts.SyntaxKind.ProtectedKeyword)
            ? 'protected'
            : ('public' as 'public' | 'private' | 'protected'),
      }));
      const properties = propertyMembers.map((m) => ({
        name: m.name?.getText() ?? 'anonymous',
        kind: 'property' as const,
        isStatic: m.modifiers?.some((mod) => mod.kind === ts.SyntaxKind.StaticKeyword) ?? false,
        accessModifier: m.modifiers?.some((mod) => mod.kind === ts.SyntaxKind.PrivateKeyword)
          ? 'private'
          : m.modifiers?.some((mod) => mod.kind === ts.SyntaxKind.ProtectedKeyword)
            ? 'protected'
            : ('public' as 'public' | 'private' | 'protected'),
      }));
      classes.push({
        name,
        signature: `${name}${extended ? ` extends ${extended}` : ''}`,
        startLine: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        endLine: sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
        methodsCount: methodMembers.length,
        propertiesCount: propertyMembers.length,
        extends: extended,
        implements:
          node.heritageClauses
            ?.filter((h) => h.token === ts.SyntaxKind.ImplementsKeyword)
            .map((h) => h.types[0]?.getText())
            .filter(Boolean) ?? [],
        methods,
        properties,
        cognitiveLoad: (methodMembers.length * 2 + propertyMembers.length) / 10,
      });
    }

    if (ts.isImportDeclaration(node)) {
      const source = node.moduleSpecifier.getText().replace(/['"]/g, '');
      const named: string[] = [];
      if (node.importClause) {
        if (node.importClause.namedBindings) {
          if (ts.isNamedImports(node.importClause.namedBindings)) {
            named.push(...node.importClause.namedBindings.elements.map((e) => e.name.getText()));
          } else if (ts.isNamespaceImport(node.importClause.namedBindings)) {
            named.push(node.importClause.namedBindings.name.getText());
          }
        }
      }
      if (node.importClause?.name) {
        named.unshift(node.importClause.name.getText());
      }
      // Detect JSON module imports (e.g. `import data from './data.json'`)
      const isJsonModule = JSON_EXTENSIONS.some((ext) => source.endsWith(ext));
      imports.push({
        source,
        named,
        kind: isJsonModule ? 'json' : 'import',
      });
    }

    // Detect dynamic imports: import('...') expressions
    // These appear as CallExpression nodes with an ImportKeyword
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (decl.initializer) {
          const dynamicImport = extractDynamicImport(decl.initializer);
          if (dynamicImport) {
            imports.push({
              source: dynamicImport,
              named: [],
              kind: 'dynamic-import',
            });
          }
        }
      }
    }

    if (ts.isExportDeclaration(node)) {
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        node.exportClause.elements.forEach((e) => exports.push(e.name.getText()));
      }
    }
  }

  // Recursively scan for dynamic imports throughout the AST
  scanForDynamicImports(sourceFile, imports);

  return {
    filePath,
    language: language ?? 'typescript',
    sizeBytes: sourceText.length,
    functions,
    classes,
    imports,
    exports,
    hash,
    lines: sourceText.split(/\r?\n/).length,
  };
}

/**
 * Extract a dynamic import source from an expression if it's a call to
 * `import('...')`. Returns the string literal source or null.
 */
function extractDynamicImport(node: ts.Expression): string | null {
  if (!ts.isCallExpression(node)) return null;
  // Dynamic import: import('...') - expression is an ImportKeyword token
  if (node.expression.kind !== ts.SyntaxKind.ImportKeyword) return null;
  if (node.arguments.length === 0) return null;
  const arg = node.arguments[0]!;
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
    return arg.text;
  }
  return null;
}

/**
 * Recursively scan the AST for dynamic import() calls and add them to the
 * imports list. Handles imports nested in:
 * - Variable declarations
 * - Assignment expressions
 * - Await expressions
 * - Conditional expressions
 * - Call expressions (Promise.all, etc.)
 * - Object/array literals
 */
function scanForDynamicImports(
  sourceFile: ts.SourceFile,
  imports: { source: string; named: string[]; kind: string }[],
): void {
  const visited = new Set<ts.Node>();

  function visit(node: ts.Node): void {
    if (visited.has(node)) return;
    visited.add(node);

    // Dynamic import: import('...') - expression is an ImportKeyword token
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      if (node.arguments.length > 0) {
        const arg = node.arguments[0]!;
        if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
          imports.push({
            source: arg.text,
            named: [],
            kind: 'dynamic-import',
          });
          return; // Don't recurse into the import call arguments
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}
