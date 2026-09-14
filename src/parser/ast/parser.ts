import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { Language, FileStructure, FunctionInfo, ClassInfo, StaticCallInfo } from '../types.js';
import { assertSourceSize, assertSourceTextSize } from '../source-limits.js';

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

/**
 * Count control-flow decisions for one function. Nested functions are their
 * own units and are deliberately excluded from the enclosing function's
 * score; otherwise a callback could make an unrelated parent look complex.
 */
export function calculateCyclomaticComplexity(node: ts.Node): number {
  let complexity = 1;
  function visit(n: ts.Node, isRoot = false) {
    if (!isRoot && ts.isFunctionLike(n)) return;
    if (ts.isIfStatement(n) || ts.isConditionalExpression(n)) complexity++;
    if (ts.isCaseClause(n) && !ts.isDefaultClause(n)) complexity++;
    if (ts.isForStatement(n) || ts.isForInStatement(n) || ts.isForOfStatement(n)) complexity++;
    if (ts.isWhileStatement(n) || ts.isDoStatement(n)) complexity++;
    // A catch clause introduces an alternate control-flow path. A throw is a
    // terminal transfer within the current path, not a new branch, and is
    // therefore intentionally excluded from cyclomatic complexity.
    if (ts.isCatchClause(n)) complexity++;
    if (
      ts.isBinaryExpression(n) &&
      (n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        n.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    )
      complexity++;
    if ((ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) && n.questionDotToken)
      complexity++;
    if (ts.isCallExpression(n) && n.questionDotToken) complexity++;
    ts.forEachChild(n, (child) => visit(child));
  }
  visit(node, true);
  return complexity;
}

type FunctionNode =
  ts.FunctionDeclaration | ts.MethodDeclaration | ts.ArrowFunction | ts.FunctionExpression;

function toFunctionInfo(node: FunctionNode, sourceFile: ts.SourceFile): FunctionInfo {
  const name = node.name?.getText() ?? 'anonymous';
  const cyclomaticComplexity = calculateCyclomaticComplexity(node);
  const params = node.parameters.map((p) => ({
    name: p.name?.getText() ?? '',
    type: p.type ? p.type.getText() : 'unknown',
  }));
  const kind: FunctionInfo['kind'] = ts.isMethodDeclaration(node)
    ? 'method'
    : ts.isArrowFunction(node)
      ? 'arrow'
      : ts.isFunctionExpression(node)
        ? 'function-expression'
        : 'function';

  return {
    name,
    signature: `${name}(${params.map((p) => `${p.name}: ${p.type}`).join(', ')})`,
    returnType: node.type ? node.type.getText() : 'void',
    startLine: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
    endLine: sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
    complexity: cyclomaticComplexity,
    kind,
    parameters: params,
    isExported: isExported(node),
    isAsync: isAsync(node),
    cyclomaticComplexity,
  };
}

function calledName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (
    ts.isElementAccessExpression(expression) &&
    expression.argumentExpression &&
    (ts.isStringLiteral(expression.argumentExpression) ||
      ts.isNoSubstitutionTemplateLiteral(expression.argumentExpression))
  ) {
    return expression.argumentExpression.text;
  }
  return null;
}

/** Extract named, statically visible call candidates without guessing dynamic dispatch. */
function collectStaticCalls(sourceFile: ts.SourceFile): StaticCallInfo[] {
  const calls: StaticCallInfo[] = [];

  function visit(node: ts.Node, activeFunction: string | null): void {
    let currentFunction = activeFunction;
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node)
    ) {
      const name = node.name?.getText(sourceFile);
      currentFunction = name && name !== 'anonymous' ? name : null;
    }

    if (currentFunction && ts.isCallExpression(node)) {
      const target = calledName(node.expression);
      if (target && target !== 'require' && target !== 'import') {
        calls.push({
          fromFunctionName: currentFunction,
          toFunctionName: target,
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        });
      }
    }

    ts.forEachChild(node, (child) => visit(child, currentFunction));
  }

  visit(sourceFile, null);
  const unique = new Map<string, StaticCallInfo>();
  for (const call of calls) {
    unique.set(`${call.fromFunctionName}\0${call.toFunctionName}\0${call.line}`, call);
  }
  return [...unique.values()].sort(
    (left, right) =>
      left.line - right.line ||
      left.fromFunctionName.localeCompare(right.fromFunctionName) ||
      left.toFunctionName.localeCompare(right.toFunctionName),
  );
}

export function parseTypeScriptFile(
  filePath: string,
  content?: string,
  language?: Language,
): FileStructure {
  if (content === undefined) assertSourceSize(filePath);
  const sourceText = content ?? readFileSync(filePath, 'utf-8');
  assertSourceTextSize(filePath, sourceText);
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);

  const functions: FunctionInfo[] = [];
  const classes: ClassInfo[] = [];
  const imports: { source: string; named: string[]; kind: string }[] = [];
  const exports: string[] = [];

  const hash = createHash('sha256').update(sourceText).digest('hex');
  const staticCalls = collectStaticCalls(sourceFile);

  for (const node of sourceFile.statements) {
    if (ts.isClassDeclaration(node)) {
      const name = node.name?.getText() ?? 'AnonymousClass';
      const extendedTypes =
        node.heritageClauses
          ?.filter((h) => h.token === ts.SyntaxKind.ExtendsKeyword)
          .flatMap((h) => h.types.map((type) => type.getText())) ?? [];
      const extended = extendedTypes.length > 0 ? extendedTypes.join(', ') : null;
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
            .flatMap((h) => h.types.map((type) => type.getText())) ?? [],
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

    if (ts.isExportDeclaration(node)) {
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        node.exportClause.elements.forEach((e) => exports.push(e.name.getText()));
      }
    }
  }

  // Function declarations and expressions can be nested inside blocks,
  // classes, callbacks, and variable initializers. Walking the full AST keeps
  // complexity and symbol counts useful for real JavaScript/TypeScript files,
  // instead of silently reporting only top-level declarations.
  function collectFunctions(node: ts.Node): void {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node)
    ) {
      functions.push(toFunctionInfo(node, sourceFile));
    }
    ts.forEachChild(node, collectFunctions);
  }
  collectFunctions(sourceFile);

  // Recursively scan for dynamic imports throughout the AST
  scanForDynamicImports(sourceFile, imports);

  return {
    filePath,
    language: language ?? 'typescript',
    // `stat.size` and the retrieval/range layers use UTF-8 bytes. Keeping the
    // persisted size in the same unit is important for incremental scanning:
    // `String.length` counts UTF-16 code units and would repeatedly invalidate
    // files containing non-ASCII source text on every scan.
    sizeBytes: Buffer.byteLength(sourceText, 'utf8'),
    sourceText,
    functions,
    classes,
    imports,
    staticCalls,
    exports,
    hash,
    lines: sourceText.split(/\r?\n/).length,
  };
}

/**
 * Recursively scan the AST for dynamic import() and static CommonJS require()
 * calls and add them to the imports list. Handles imports nested in:
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

    // CommonJS packages remain first-class JS/TS projects. Record only the
    // static string form; computed require() calls cannot be trusted as graph
    // edges and stay outside the static dependency contract.
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require'
    ) {
      const arg = node.arguments[0];
      if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
        imports.push({
          source: arg.text,
          named: [],
          kind: 'require',
        });
        return;
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}
