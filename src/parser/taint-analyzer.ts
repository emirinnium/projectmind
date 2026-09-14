import { reportSuppressedError } from '../utils/errors.js';
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { FileStructure } from './ast-parser.js';
import type { StructuralLanguage } from './language-service.js';
import { KnowledgeGraph } from '../storage/knowledge-graph.js';
import { sanitizeIdentity } from './taint-utils.js';
import { canonicalIdentityPath } from '../core/project/worktree-identity.js';

export interface TaintSource {
  kind:
    | 'FILE'
    | 'NETWORK'
    | 'DATABASE'
    | 'ENV'
    | 'STDIN'
    | 'STDOUT'
    | 'STDERR'
    | 'SOCKET'
    | 'PROCESS'
    | 'CODE';
  qualifiedName: string;
  identity: string;
  node: ts.Node;
}

export interface TaintSink {
  qualifiedName: string;
  kind: TaintSource['kind'];
  identity: string;
  node: ts.Node;
}

export type TaintPathNodeType = 'source' | 'sink' | 'intermediate' | 'sanitizer';

export interface TaintPathNode {
  node: ts.Node;
  type: TaintPathNodeType;
  /** Absolute source file containing this evidence node. */
  filePath?: string;
  function?: string;
  variable?: string;
}

export interface TaintFlow {
  source: TaintSource;
  sink: TaintSink;
  viaFunction?: string;
  viaVariable?: string;
  /** True when a known sanitizer/validator was observed between source and sink. */
  sanitized?: boolean;
  path: TaintPathNode[];
}

export interface InterFileTaintFlow {
  sourceFilePath: string;
  sinkFilePath: string;
  source: TaintSource;
  sink: TaintSink;
  viaFunction?: string;
  sanitized?: boolean;
  path: TaintPathNode[];
}

export interface ProjectTaintAnalysis {
  localFlows: TaintFlow[];
  interFileFlows: InterFileTaintFlow[];
  analyzedFiles: number;
  limitations: string[];
}

interface AnalysisOptions {
  initialTaint?: Map<string, TaintSource>;
  rootNodes?: readonly ts.Node[];
}

interface ExportedFunction {
  exportName: string;
  node: ts.FunctionLikeDeclaration;
}

interface ImportedFunctionBinding {
  localName: string;
  importedName: string;
  targetFilePath: string;
}

interface TaintBoundaryCall {
  sourceFilePath: string;
  targetFilePath: string;
  targetFunctionName: string;
  source: TaintSource;
  viaFunction?: string;
  argument: string;
  argumentIndex: number;
  sanitized?: boolean;
  path: TaintPathNode[];
}

type ResourceKind = TaintSource['kind'];

interface Pattern {
  pattern: RegExp;
  kind: ResourceKind;
  extractIdentity: (text: string) => string;
}

const SOURCE_PATTERNS: readonly Pattern[] = [
  {
    pattern: /^fs\.readFile(Sync)?$/,
    kind: 'FILE',
    extractIdentity: (text) =>
      sanitizeIdentity(text.replace(/^fs\.readFile(Sync)?\(/, '').replace(/[)'\"]/g, '')),
  },
  {
    pattern: /^(?:fs\.)?(?:promises\.)?(?:createReadStream|readFile|readFileSync)$/,
    kind: 'FILE',
    extractIdentity: (text) =>
      sanitizeIdentity(text.replace(/^fs\.createReadStream\(/, '').replace(/[)'\"]/g, '')),
  },
  {
    pattern: /^process\.env(?:\.[A-Za-z_$][\w$]*)?$/,
    kind: 'ENV',
    extractIdentity: (text) => sanitizeIdentity(text.replace(/^process\.env\./, '')),
  },
  {
    pattern: /^process\.stdin$/,
    kind: 'STDIN',
    extractIdentity: () => 'process.stdin',
  },
  {
    pattern: /^process\.argv$/,
    kind: 'PROCESS',
    extractIdentity: () => 'process.argv',
  },
  {
    pattern: /^(?:req|request)\.(?:body|query|params)$/,
    kind: 'NETWORK',
    extractIdentity: sanitizeIdentity,
  },
  {
    pattern: /^(?:window\.)?location(?:\.search|\.hash|\.href)?$/,
    kind: 'NETWORK',
    extractIdentity: sanitizeIdentity,
  },
  {
    pattern: /^(?:window\.)?localStorage\.getItem$/,
    kind: 'DATABASE',
    extractIdentity: sanitizeIdentity,
  },
  {
    pattern: /^fetch$/,
    kind: 'NETWORK',
    extractIdentity: (text) =>
      sanitizeIdentity(text.replace(/^fetch\(/, '').replace(/[)'\"]/g, '')),
  },
  {
    pattern: /^http\.request$/,
    kind: 'NETWORK',
    extractIdentity: (text) =>
      sanitizeIdentity(text.replace(/^http\.request\(/, '').replace(/[)'\"]/g, '')),
  },
  {
    pattern: /^https\.request$/,
    kind: 'NETWORK',
    extractIdentity: (text) =>
      sanitizeIdentity(text.replace(/^https\.request\(/, '').replace(/[)'\"]/g, '')),
  },
  {
    pattern: /^net\.connect$/,
    kind: 'SOCKET',
    extractIdentity: (text) =>
      sanitizeIdentity(text.replace(/^net\.connect\(/, '').replace(/[)'\"]/g, '')),
  },
];

const SINK_PATTERNS: readonly Pattern[] = [
  { pattern: /^(?:eval|Function)$/, kind: 'CODE', extractIdentity: () => 'dynamic-code' },
  {
    pattern: /^(?:exec|execSync|execFile|execFileSync|spawn|spawnSync)$/,
    kind: 'PROCESS',
    extractIdentity: sanitizeIdentity,
  },
  {
    pattern: /^child_process\.(?:exec|execSync|execFile|execFileSync|spawn|spawnSync)$/,
    kind: 'PROCESS',
    extractIdentity: sanitizeIdentity,
  },
  {
    // Require a receiver for generic database APIs. Treating every bare
    // `execute(...)` helper as a database sink creates broad false positives
    // and hides the inter-file boundary signal we are trying to report.
    pattern: /^(?:[A-Za-z_$][\w$]*\.)+(?:query|execute)$/,
    kind: 'DATABASE',
    extractIdentity: sanitizeIdentity,
  },
  {
    pattern: /^(?:[A-Za-z_$][\w$]*\.)?(?:send|json)$/,
    kind: 'NETWORK',
    extractIdentity: sanitizeIdentity,
  },
  {
    pattern: /^(?:[A-Za-z_$][\w$]*\.)?(?:write|writeFile|writeFileSync|createWriteStream)$/,
    kind: 'FILE',
    extractIdentity: sanitizeIdentity,
  },
  {
    pattern: /^console\.(?:log|info|warn|error|debug)$/,
    kind: 'STDOUT',
    extractIdentity: sanitizeIdentity,
  },
];

function isSupportedLanguage(language: FileStructure['language']): language is StructuralLanguage {
  return language === 'typescript' || language === 'javascript';
}

function isKnownSanitizer(calleeText: string): boolean {
  return /(?:sanitize|escape|encode|validate|parse|safe)$/iu.test(calleeText);
}

/** TypeScript/JavaScript taint analysis using one precise compiler-AST path. */
export class TaintAnalyzer {
  constructor(private readonly kg: KnowledgeGraph) {}

  analyze(filePath: string, fileStructure: FileStructure): TaintFlow[] {
    if (!isSupportedLanguage(fileStructure.language)) return [];
    try {
      return this.analyzeSource(filePath, readFileSync(filePath, 'utf-8'), fileStructure.language);
    } catch (error) {
      reportSuppressedError(error, 'Intentional fallback src/parser/taint-analyzer.ts:127');
      return [];
    }
  }

  analyzeSource(filePath: string, content: string, language: StructuralLanguage): TaintFlow[] {
    if (!isSupportedLanguage(language)) return [];
    return this.analyzeTypeScript(filePath, content, language);
  }

  /**
   * Analyze statically resolved import boundaries for a bounded project view.
   *
   * This intentionally joins only three pieces of evidence: a recognized
   * source in the caller, a resolved static import, and a named exported
   * function whose parameter reaches a recognized sink. It does not infer
   * framework routes, dynamic dispatch, runtime registration, or exploitability.
   */
  analyzeProject(entryFilePath: string, maxFiles = 200): ProjectTaintAnalysis {
    const allFiles = this.kg
      .getAllFiles()
      .filter((file) => isSupportedLanguage(file.language as FileStructure['language']))
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    const requestedLimit = Number.isSafeInteger(maxFiles) && maxFiles > 0 ? maxFiles : 200;
    const fileLimit = Math.max(1, Math.min(requestedLimit, 500));
    const entryPath = resolve(entryFilePath);
    const entryIdentity = canonicalIdentityPath(entryPath);
    const indexedEntry = allFiles.find(
      (file) => canonicalIdentityPath(resolve(file.path)) === entryIdentity,
    );
    if (!indexedEntry) {
      return {
        localFlows: [],
        interFileFlows: [],
        analyzedFiles: 0,
        limitations: [
          'The requested entry file is not indexed; run scan_project before requesting project taint analysis.',
        ],
      };
    }
    const selectedFiles = allFiles.slice(0, fileLimit);
    if (
      !selectedFiles.some((file) => canonicalIdentityPath(resolve(file.path)) === entryIdentity)
    ) {
      selectedFiles.splice(Math.max(0, selectedFiles.length - 1), 1, indexedEntry);
    }
    const boundedFiles = selectedFiles;
    const files = new Map<string, { path: string; relativePath: string; content: string }>();

    for (const file of boundedFiles) {
      try {
        files.set(canonicalIdentityPath(resolve(file.path)), {
          path: resolve(file.path),
          relativePath: file.relativePath.replace(/\\/g, '/'),
          content: readFileSync(file.path, 'utf-8'),
        });
      } catch (error) {
        reportSuppressedError(error, 'Intentional fallback src/parser/taint-analyzer.ts:226');
      }
    }

    const localFlows: TaintFlow[] = [];
    const boundaries: TaintBoundaryCall[] = [];
    const summaries = new Map<string, { parameterNames: string[]; flows: TaintFlow[] }>();
    const parsed = new Map<string, ts.SourceFile>();
    const staticImports = new Map<string, Set<string>>();

    for (const file of files.values()) {
      const normalizedFilePath = file.path.toLowerCase();
      const language =
        normalizedFilePath.endsWith('.tsx') || normalizedFilePath.endsWith('.ts')
          ? 'typescript'
          : 'javascript';
      const sourceFile = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true);
      parsed.set(file.path, sourceFile);
      const importedPaths = new Set<string>();
      const fromDir = dirname(file.relativePath).replace(/\\/g, '/');
      for (const statement of sourceFile.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
          continue;
        }
        const target = this.kg.resolveImportSource(statement.moduleSpecifier.text, fromDir);
        if (!target) continue;
        const targetIdentity = canonicalIdentityPath(resolve(target.path));
        if (files.has(targetIdentity)) importedPaths.add(targetIdentity);
      }
      staticImports.set(canonicalIdentityPath(file.path), importedPaths);
      localFlows.push(...this.analyzeSource(file.path, file.content, language));
      boundaries.push(...this.collectTaintBoundaryCalls(file, sourceFile));

      for (const exported of this.collectExportedFunctions(sourceFile)) {
        const initialTaint = new Map<string, TaintSource>();
        for (const parameter of exported.node.parameters) {
          if (!parameter.name || !ts.isIdentifier(parameter.name)) continue;
          initialTaint.set(parameter.name.text, {
            kind: 'CODE',
            qualifiedName: `${exported.exportName}.${parameter.name.text}`,
            identity: parameter.name.text,
            node: parameter.name,
          });
        }
        if (initialTaint.size === 0) continue;
        const parameterFlows = this.analyzeTypeScript(file.path, file.content, language, {
          initialTaint,
          rootNodes: [exported.node],
        }).filter((flow) => flow.source.kind === 'CODE');
        summaries.set(`${canonicalIdentityPath(file.path)}\0${exported.exportName}`, {
          parameterNames: exported.node.parameters.flatMap((parameter) =>
            parameter.name && ts.isIdentifier(parameter.name) ? [parameter.name.text] : [],
          ),
          flows: parameterFlows,
        });
      }
    }

    // Project mode is rooted at the requested file. Do not report unrelated
    // source-to-sink candidates merely because they happen to be indexed in
    // the same repository. Only statically resolved ES-import descendants are
    // in scope; dynamic/runtime reachability remains an explicit limitation.
    const reachable = new Set<string>([entryIdentity]);
    const queue = [entryIdentity];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const target of staticImports.get(current) ?? []) {
        if (reachable.has(target)) continue;
        reachable.add(target);
        queue.push(target);
      }
    }
    const scopedLocalFlows = localFlows.filter((flow) => {
      const sourcePath = flow.path.find((step) => step.type === 'source')?.filePath;
      return sourcePath ? reachable.has(canonicalIdentityPath(sourcePath)) : false;
    });
    const scopedBoundaries = boundaries.filter((boundary) =>
      reachable.has(canonicalIdentityPath(boundary.sourceFilePath)),
    );
    const scopedParsedFiles = [...parsed.keys()].filter((path) =>
      reachable.has(canonicalIdentityPath(path)),
    );

    const interFileFlows: InterFileTaintFlow[] = [];
    const seen = new Set<string>();
    for (const boundary of scopedBoundaries) {
      const summary = summaries.get(
        `${canonicalIdentityPath(boundary.targetFilePath)}\0${boundary.targetFunctionName}`,
      );
      for (const flow of summary?.flows ?? []) {
        const parameter = flow.source.identity;
        if (parameter !== summary?.parameterNames[boundary.argumentIndex]) {
          continue;
        }
        const key = `${boundary.sourceFilePath}\0${boundary.targetFilePath}\0${boundary.targetFunctionName}\0${boundary.argument}\0${flow.sink.qualifiedName}\0${flow.sink.node.getStart()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const targetParameter = flow.path[0];
        interFileFlows.push({
          sourceFilePath: boundary.sourceFilePath,
          sinkFilePath: boundary.targetFilePath,
          source: boundary.source,
          sink: flow.sink,
          viaFunction: [boundary.viaFunction, boundary.targetFunctionName]
            .filter((value): value is string => Boolean(value))
            .join(' → '),
          sanitized: boundary.sanitized === true || flow.sanitized === true,
          path: [
            ...boundary.path,
            ...(targetParameter
              ? [
                  {
                    ...targetParameter,
                    type: 'intermediate' as const,
                    filePath: boundary.targetFilePath,
                  },
                ]
              : []),
            ...flow.path.slice(1).map((step) => ({ ...step, filePath: boundary.targetFilePath })),
          ],
        });
      }
    }

    const limitations = [
      'Only statically resolved JS/TS imports and named exported function boundaries are followed.',
      'Project mode is scoped to the forward static import closure of the requested indexed entry file; unrelated indexed files are excluded.',
      'Dynamic imports, CommonJS computed requires, framework routes, callbacks, aliases not represented by the graph, and runtime dispatch are not proven.',
      'A cross-file candidate is static evidence, not a confirmed vulnerability or an executable reproduction.',
    ];
    if (boundedFiles.length < allFiles.length) {
      limitations.push(
        `Analysis was bounded to ${boundedFiles.length} of ${allFiles.length} indexed source files.`,
      );
    }
    if (scopedParsedFiles.length === 0) {
      limitations.push('No readable indexed JS/TS source file was available in the entry closure.');
    }

    return {
      localFlows: scopedLocalFlows,
      interFileFlows,
      analyzedFiles: scopedParsedFiles.length,
      limitations,
    };
  }

  private matchSource(
    text: string,
  ): { kind: TaintSource['kind']; qualifiedName: string; identity: string } | undefined {
    for (const { pattern, kind, extractIdentity } of SOURCE_PATTERNS) {
      const match = text.match(pattern);
      if (match) return { kind, qualifiedName: match[0]!, identity: extractIdentity(text) };
    }
    return undefined;
  }

  private matchSink(text: string): { kind: TaintSink['kind']; identity: string } | null {
    for (const { pattern, kind, extractIdentity } of SINK_PATTERNS) {
      if (pattern.test(text)) return { kind, identity: extractIdentity(text) };
    }
    return null;
  }

  private collectExportedFunctions(sourceFile: ts.SourceFile): ExportedFunction[] {
    const functions = new Map<string, ts.FunctionLikeDeclaration>();
    const localFunctions = new Map<string, ts.FunctionLikeDeclaration>();

    const isFunctionLike = (node: ts.Node): node is ts.FunctionLikeDeclaration =>
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node);
    const hasExport = (node: ts.Node): boolean => {
      if (!ts.canHaveModifiers(node)) return false;
      return (
        ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ??
        false
      );
    };

    for (const statement of sourceFile.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name) {
        localFunctions.set(statement.name.text, statement);
        if (hasExport(statement)) functions.set(statement.name.text, statement);
        continue;
      }
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
        if (!isFunctionLike(declaration.initializer)) continue;
        localFunctions.set(declaration.name.text, declaration.initializer);
        if (hasExport(statement)) functions.set(declaration.name.text, declaration.initializer);
      }
    }

    for (const statement of sourceFile.statements) {
      if (!ts.isExportDeclaration(statement) || !statement.exportClause) continue;
      if (!ts.isNamedExports(statement.exportClause)) continue;
      for (const element of statement.exportClause.elements) {
        const localName = element.propertyName?.text ?? element.name.text;
        const localFunction = localFunctions.get(localName);
        if (localFunction) functions.set(element.name.text, localFunction);
      }
    }

    return [...functions.entries()]
      .map(([exportName, node]) => ({ exportName, node }))
      .sort((left, right) => left.exportName.localeCompare(right.exportName));
  }

  private collectTaintBoundaryCalls(
    file: { path: string; relativePath: string },
    sourceFile: ts.SourceFile,
  ): TaintBoundaryCall[] {
    const bindings = new Map<string, ImportedFunctionBinding>();
    const namespaces = new Map<string, { targetFilePath: string }>();
    const fromDir = dirname(file.relativePath).replace(/\\/g, '/');

    for (const statement of sourceFile.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
        continue;
      }
      const target = this.kg.resolveImportSource(statement.moduleSpecifier.text, fromDir);
      if (!target) continue;
      const clause = statement.importClause;
      if (!clause) continue;
      if (clause.name) {
        bindings.set(clause.name.text, {
          localName: clause.name.text,
          importedName: 'default',
          targetFilePath: resolve(target.path),
        });
      }
      if (!clause.namedBindings) continue;
      if (ts.isNamespaceImport(clause.namedBindings)) {
        namespaces.set(clause.namedBindings.name.text, { targetFilePath: resolve(target.path) });
        continue;
      }
      for (const element of clause.namedBindings.elements) {
        bindings.set(element.name.text, {
          localName: element.name.text,
          importedName: element.propertyName?.text ?? element.name.text,
          targetFilePath: resolve(target.path),
        });
      }
    }

    const variables = new Map<string, TaintSource>();
    const sanitizerNodes = new Map<string, ts.Node>();
    const boundaries: TaintBoundaryCall[] = [];
    const seen = new Set<string>();

    const getQualifiedName = (node: ts.Node): string => {
      if (ts.isIdentifier(node)) return node.text;
      if (ts.isPropertyAccessExpression(node)) {
        return `${getQualifiedName(node.expression)}.${node.name.text}`;
      }
      if (ts.isCallExpression(node)) return getQualifiedName(node.expression);
      return node.getText(sourceFile);
    };
    const getTaintedSource = (node: ts.Node): TaintSource | undefined => {
      const variable = node.getText(sourceFile);
      const direct = variables.get(variable);
      if (direct) return direct;
      const source = this.matchSource(sanitizeIdentity(getQualifiedName(node)));
      if (!source) return undefined;
      return { ...source, identity: source.identity, node };
    };

    const visit = (node: ts.Node, currentFunctionName: string | undefined): void => {
      let activeFunctionName = currentFunctionName;
      if (
        ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isArrowFunction(node) ||
        ts.isFunctionExpression(node)
      ) {
        activeFunctionName = node.name?.getText(sourceFile) ?? currentFunctionName;
      }

      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const variable = node.name.text;
        const directSource = getTaintedSource(node.initializer);
        if (directSource) variables.set(variable, { ...directSource, node });
        if (ts.isCallExpression(node.initializer)) {
          const calleeText = sanitizeIdentity(getQualifiedName(node.initializer.expression));
          if (isKnownSanitizer(calleeText)) {
            const sourceVariable = node.initializer.arguments[0]
              ? variables.get(node.initializer.arguments[0]!.getText(sourceFile))
              : undefined;
            if (sourceVariable) {
              variables.set(variable, sourceVariable);
              sanitizerNodes.set(variable, node.initializer);
            }
          }
        }
      }

      if (ts.isCallExpression(node)) {
        let binding: ImportedFunctionBinding | undefined;
        const callee = node.expression;
        if (ts.isIdentifier(callee)) {
          binding = bindings.get(callee.text);
        } else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
          const namespace = namespaces.get(callee.expression.text);
          if (namespace) {
            binding = {
              localName: callee.getText(sourceFile),
              importedName: callee.name.text,
              targetFilePath: namespace.targetFilePath,
            };
          }
        }
        if (binding) {
          for (const [argumentIndex, argument] of node.arguments.entries()) {
            const source = getTaintedSource(argument);
            if (!source) continue;
            const argumentName = argument.getText(sourceFile);
            const key = `${node.getStart()}\0${argumentName}\0${binding.targetFilePath}\0${binding.importedName}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const sanitizer = sanitizerNodes.get(argumentName);
            boundaries.push({
              sourceFilePath: file.path,
              targetFilePath: binding.targetFilePath,
              targetFunctionName: binding.importedName,
              source,
              viaFunction: activeFunctionName,
              argument: argumentName,
              argumentIndex,
              sanitized: Boolean(sanitizer),
              path: [
                {
                  node: source.node,
                  type: 'source',
                  filePath: file.path,
                  function: activeFunctionName,
                  variable: argumentName,
                },
                ...(sanitizer
                  ? [{ node: sanitizer, type: 'sanitizer' as const, filePath: file.path }]
                  : []),
                {
                  node,
                  type: 'intermediate',
                  filePath: file.path,
                  function: activeFunctionName,
                  variable: argumentName,
                },
              ],
            });
          }
        }
      }

      ts.forEachChild(node, (child) => visit(child, activeFunctionName));
    };

    ts.forEachChild(sourceFile, (child) => visit(child, undefined));
    return boundaries;
  }

  private analyzeTypeScript(
    filePath: string,
    content: string,
    _language: StructuralLanguage,
    options: AnalysisOptions = {},
  ): TaintFlow[] {
    const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
    const flows: TaintFlow[] = [];
    const variables = new Map<string, TaintSource>(options.initialTaint ?? []);
    const parameterTaint = new Map<string, TaintSource>();
    const interProceduralPaths = new Map<string, TaintPathNode[]>();
    const localFns = new Map<string, { node: ts.Node; params: string[] }>();
    const sanitizedVariables = new Set<string>();
    const sanitizerNodes = new Map<string, ts.Node>();

    const getQualifiedName = (node: ts.Node): string => {
      if (ts.isIdentifier(node)) return node.text;
      if (ts.isPropertyAccessExpression(node)) {
        return `${getQualifiedName(node.expression)}.${node.name.text}`;
      }
      if (ts.isCallExpression(node)) return getQualifiedName(node.expression);
      return node.getText(sourceFile);
    };

    const extractIdentityFromInit = (node: ts.Node, source: { identity: string }): string => {
      if (ts.isCallExpression(node) && node.arguments.length > 0) {
        return sanitizeIdentity(node.arguments[0]!.getText(sourceFile).replace(/[)'\"]/g, ''));
      }
      if (ts.isPropertyAccessExpression(node)) return sanitizeIdentity(node.name.text);
      return sanitizeIdentity(source.identity);
    };

    const extractIdentityFromCall = (
      node: ts.CallExpression,
      source: { identity: string },
    ): string => {
      if (node.arguments.length > 0) {
        return sanitizeIdentity(node.arguments[0]!.getText(sourceFile).replace(/[)'\"]/g, ''));
      }
      return sanitizeIdentity(source.identity);
    };

    const visit = (
      node: ts.Node,
      currentFunctionName: string | undefined,
      path: TaintPathNode[] = [],
    ): void => {
      const currentPath = [...path];

      if (ts.isVariableDeclaration(node) && node.initializer && node.name) {
        const initNode = node.initializer;
        const calleeText = sanitizeIdentity(getQualifiedName(initNode));
        const source = this.matchSource(calleeText);
        if (source) {
          const variable = node.name.getText(sourceFile);
          const taintSource = {
            ...source,
            identity: extractIdentityFromInit(initNode, source),
            node,
          };
          variables.set(variable, taintSource);
          currentPath.push({ node, type: 'source', function: currentFunctionName, variable });
        }

        // Preserve source identity through a known sanitizer/validator. The
        // sanitizer is recorded as evidence rather than treated as proof that
        // the eventual sink is safe. This handles common `const clean =
        // escape(raw)` / `schema.parse(raw)` shapes without executing code.
        if (ts.isCallExpression(initNode) && isKnownSanitizer(calleeText)) {
          const argument = initNode.arguments[0];
          const sourceVariable = argument ? variables.get(argument.getText(sourceFile)) : undefined;
          if (sourceVariable) {
            const variable = node.name.getText(sourceFile);
            variables.set(variable, sourceVariable);
            sanitizedVariables.add(variable);
            sanitizerNodes.set(variable, initNode);
          }
        }
      }

      if (ts.isCallExpression(node)) {
        const calleeText = sanitizeIdentity(getQualifiedName(node.expression));
        const source = this.matchSource(calleeText);
        if (source) {
          const identity = extractIdentityFromCall(node, source);
          for (const argument of node.arguments) {
            const variable = argument.getText(sourceFile);
            const variableSource = variables.get(variable);
            if (!variableSource) continue;
            const sanitized = sanitizedVariables.has(variable);
            const sanitizer = sanitizerNodes.get(variable);
            flows.push({
              source: { ...variableSource, identity },
              sink: { qualifiedName: calleeText, kind: source.kind, identity: calleeText, node },
              viaFunction: currentFunctionName,
              viaVariable: variable,
              sanitized,
              path: [
                ...currentPath,
                {
                  node: variableSource.node,
                  type: 'source',
                  function: currentFunctionName,
                  variable,
                },
                ...(sanitizer
                  ? [{ node: sanitizer, type: 'sanitizer' as const, function: currentFunctionName }]
                  : []),
                { node, type: 'intermediate', function: currentFunctionName },
              ],
            });
          }
        }

        if (calleeText && !calleeText.includes('.') && !calleeText.includes('(')) {
          const fn = localFns.get(calleeText);
          if (fn) {
            node.arguments.forEach((argument, index) => {
              const variable = argument.getText(sourceFile);
              const variableSource = variables.get(variable);
              const parameter = fn.params[index];
              if (!variableSource || !parameter || parameterTaint.has(`${calleeText}.${parameter}`))
                return;
              parameterTaint.set(`${calleeText}.${parameter}`, variableSource);
              interProceduralPaths.set(`${calleeText}.${parameter}`, [
                ...currentPath,
                {
                  node: variableSource.node,
                  type: 'source',
                  function: currentFunctionName,
                  variable,
                },
                { node: argument, type: 'intermediate', function: currentFunctionName },
              ]);
            });
          }
        }

        const sink = this.matchSink(calleeText);
        if (sink) {
          for (const argument of node.arguments) {
            const variable = argument.getText(sourceFile);
            const variableSource = variables.get(variable);
            if (!variableSource) continue;
            const sanitized = sanitizedVariables.has(variable);
            const sanitizer = sanitizerNodes.get(variable);
            flows.push({
              source: variableSource,
              sink: {
                qualifiedName: calleeText,
                kind: sink.kind,
                identity: sanitizeIdentity(sink.identity),
                node,
              },
              viaFunction: currentFunctionName,
              viaVariable: variable,
              sanitized,
              path: [
                ...currentPath,
                {
                  node: variableSource.node,
                  type: 'source',
                  function: currentFunctionName,
                  variable,
                },
                ...(sanitizer
                  ? [{ node: sanitizer, type: 'sanitizer' as const, function: currentFunctionName }]
                  : []),
                { node, type: 'sink', function: currentFunctionName },
              ],
            });
          }
        }
      }

      ts.forEachChild(node, (child) => visit(child, currentFunctionName, currentPath));
    };

    ts.forEachChild(sourceFile, function collect(node: ts.Node): void {
      if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name) {
        localFns.set(node.name.getText(sourceFile), {
          node,
          params: node.parameters.map((parameter) =>
            parameter.name && ts.isIdentifier(parameter.name) ? parameter.name.text : '',
          ),
        });
      }
      ts.forEachChild(node, collect);
    });

    const roots = options.rootNodes ?? sourceFile.statements;
    for (const statement of roots) {
      if (ts.isFunctionDeclaration(statement) || ts.isMethodDeclaration(statement)) {
        visit(statement, statement.name?.getText(sourceFile));
      } else {
        visit(statement, undefined);
      }
    }

    for (const [functionName, fn] of localFns) {
      const seeds = fn.params
        .map((parameter) => ({
          parameter,
          source: parameterTaint.get(`${functionName}.${parameter}`),
          path: interProceduralPaths.get(`${functionName}.${parameter}`),
        }))
        .filter(
          (seed): seed is { parameter: string; source: TaintSource; path: TaintPathNode[] } =>
            !!seed.source && !!seed.path,
        );
      if (seeds.length === 0) continue;

      for (const seed of seeds) {
        variables.set(seed.parameter, seed.source);
        interProceduralPaths.set(`local.${seed.parameter}`, seed.path);
      }

      const before = flows.length;
      ts.forEachChild(fn.node, (child) => visit(child, functionName));
      for (let index = before; index < flows.length; index++) {
        const seed = seeds.find((candidate) => candidate.parameter === flows[index]!.viaVariable);
        if (!seed) continue;
        flows[index] = {
          ...flows[index]!,
          viaFunction: `${functionName} → ${flows[index]!.viaFunction ?? '(body)'}`,
          path: [...seed.path, ...flows[index]!.path.slice(1)],
        };
      }
      for (const seed of seeds) variables.delete(seed.parameter);
    }

    return flows.map((flow) => ({
      ...flow,
      path: flow.path.map((step) => ({ ...step, filePath })),
    }));
  }

  recordFlows(filePath: string, content: string, language: StructuralLanguage): number {
    const flows = this.analyzeSource(filePath, content, language);
    let recorded = 0;
    for (const flow of flows) {
      try {
        this.kg.recordDataFlow({
          fromResourceQualifiedName: flow.source.qualifiedName,
          fromResourceKind: flow.source.kind,
          fromResourceIdentity: flow.source.identity,
          toResourceQualifiedName: flow.sink.qualifiedName,
          toResourceKind: flow.sink.kind,
          toResourceIdentity: flow.sink.identity,
          kind: 'arg',
          via: flow.viaFunction,
          sourceFunctionName: flow.viaFunction,
          targetFunctionName: flow.viaFunction,
        });
        recorded++;
      } catch (error) {
        reportSuppressedError(error, 'Intentional fallback src/parser/taint-analyzer.ts:375');
        // Duplicate or invalid flow records are safe to skip.
      }
    }
    return recorded;
  }
}
