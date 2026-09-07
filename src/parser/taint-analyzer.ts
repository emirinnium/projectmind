import ts from 'typescript';
import { readFileSync } from 'node:fs';
import type { FileStructure } from './ast-parser.js';
import type { StructuralLanguage } from './language-service.js';
import { KnowledgeGraph } from '../storage/knowledge-graph.js';
import { sanitizeIdentity } from './taint-utils.js';

export interface TaintSource {
  kind: 'FILE' | 'NETWORK' | 'DATABASE' | 'ENV' | 'STDIN' | 'STDOUT' | 'STDERR' | 'SOCKET';
  qualifiedName: string;
  identity: string;
  node: ts.Node;
}

export interface TaintSink {
  qualifiedName: string;
  kind: 'FILE' | 'NETWORK' | 'DATABASE' | 'ENV' | 'STDIN' | 'STDOUT' | 'STDERR' | 'SOCKET';
  identity: string;
  node: ts.Node;
}

export type TaintPathNodeType = 'source' | 'sink' | 'intermediate';

export interface TaintPathNode {
  node: ts.Node;
  type: TaintPathNodeType;
  function?: string;
  variable?: string;
}

export interface TaintFlow {
  source: TaintSource;
  sink: TaintSink;
  viaFunction?: string;
  viaVariable?: string;
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
    pattern: /^fs\.createReadStream$/,
    kind: 'FILE',
    extractIdentity: (text) =>
      sanitizeIdentity(text.replace(/^fs\.createReadStream\(/, '').replace(/[)'\"]/g, '')),
  },
  {
    pattern: /^process\.env$/,
    kind: 'ENV',
    extractIdentity: (text) => sanitizeIdentity(text.replace(/^process\.env\./, '')),
  },
  {
    pattern: /^process\.stdin$/,
    kind: 'STDIN',
    extractIdentity: () => 'process.stdin',
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
  { pattern: /^eval$/, kind: 'ENV', extractIdentity: () => 'eval' },
  { pattern: /^Function$/, kind: 'ENV', extractIdentity: () => 'Function' },
  { pattern: /^exec$/, kind: 'SOCKET', extractIdentity: sanitizeIdentity },
  { pattern: /^execSync$/, kind: 'SOCKET', extractIdentity: sanitizeIdentity },
  { pattern: /^execFile$/, kind: 'SOCKET', extractIdentity: sanitizeIdentity },
  { pattern: /^spawn$/, kind: 'SOCKET', extractIdentity: sanitizeIdentity },
  { pattern: /^child_process\.exec$/, kind: 'SOCKET', extractIdentity: sanitizeIdentity },
  { pattern: /^child_process\.spawn$/, kind: 'SOCKET', extractIdentity: sanitizeIdentity },
  { pattern: /^query$/, kind: 'DATABASE', extractIdentity: sanitizeIdentity },
  { pattern: /^execute$/, kind: 'DATABASE', extractIdentity: sanitizeIdentity },
  { pattern: /^send$/, kind: 'NETWORK', extractIdentity: sanitizeIdentity },
  { pattern: /^write$/, kind: 'FILE', extractIdentity: sanitizeIdentity },
  { pattern: /^writeFile$/, kind: 'FILE', extractIdentity: sanitizeIdentity },
  { pattern: /^writeFileSync$/, kind: 'FILE', extractIdentity: sanitizeIdentity },
  { pattern: /^createWriteStream$/, kind: 'FILE', extractIdentity: sanitizeIdentity },
];

function isSupportedLanguage(language: FileStructure['language']): language is StructuralLanguage {
  return language === 'typescript' || language === 'javascript';
}

/** TypeScript/JavaScript taint analysis using one precise compiler-AST path. */
export class TaintAnalyzer {
  constructor(private readonly kg: KnowledgeGraph) {}

  analyze(filePath: string, fileStructure: FileStructure): TaintFlow[] {
    if (!isSupportedLanguage(fileStructure.language)) return [];
    try {
      return this.analyzeSource(filePath, readFileSync(filePath, 'utf-8'), fileStructure.language);
    } catch {
      return [];
    }
  }

  analyzeSource(filePath: string, content: string, language: StructuralLanguage): TaintFlow[] {
    return this.analyzeTypeScript(filePath, content, language);
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

  private analyzeTypeScript(
    filePath: string,
    content: string,
    _language: StructuralLanguage,
  ): TaintFlow[] {
    const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
    const flows: TaintFlow[] = [];
    const variables = new Map<string, TaintSource>();
    const parameterTaint = new Map<string, TaintSource>();
    const interProceduralPaths = new Map<string, TaintPathNode[]>();
    const localFns = new Map<string, { node: ts.Node; params: string[] }>();

    const getQualifiedName = (node: ts.Node): string => {
      if (ts.isIdentifier(node)) return node.text;
      if (ts.isPropertyAccessExpression(node)) {
        return `${getQualifiedName(node.expression)}.${node.name.text}`;
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        return getQualifiedName(node.expression);
      }
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
            flows.push({
              source: { ...variableSource, identity },
              sink: { qualifiedName: calleeText, kind: source.kind, identity: calleeText, node },
              viaFunction: currentFunctionName,
              viaVariable: variable,
              path: [
                ...currentPath,
                {
                  node: variableSource.node,
                  type: 'source',
                  function: currentFunctionName,
                  variable,
                },
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
              path: [
                ...currentPath,
                {
                  node: variableSource.node,
                  type: 'source',
                  function: currentFunctionName,
                  variable,
                },
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

    for (const statement of sourceFile.statements) {
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

    return flows;
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
      } catch {
        // Duplicate or invalid flow records are safe to skip.
      }
    }
    return recorded;
  }
}
