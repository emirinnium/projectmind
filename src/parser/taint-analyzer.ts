import ts from 'typescript';
import { readFileSync } from 'node:fs';
import type { FileStructure } from './ast-parser.js';
import { KnowledgeGraph } from '../storage/knowledge-graph.js';

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

export interface TaintFlow {
  source: TaintSource;
  sink: TaintSink;
  viaFunction?: string;
  viaVariable?: string;
}

// Known source patterns: module.function or function name -> kind
const SOURCE_PATTERNS: Array<{ pattern: RegExp; kind: TaintSource['kind']; extractIdentity: (text: string) => string }> = [
  { pattern: /^fs\.readFile(Sync)?$/, kind: 'FILE', extractIdentity: (text) => text.replace(/^fs\.readFile(Sync)?\(/, '').replace(/[)'"]/g, '').trim() },
  { pattern: /^fs\.createReadStream$/, kind: 'FILE', extractIdentity: (text) => text.replace(/^fs\.createReadStream\(/, '').replace(/[)'"]/g, '').trim() },
  { pattern: /^process\.env$/, kind: 'ENV', extractIdentity: (text) => text.replace(/^process\.env\./, '').trim() },
  { pattern: /^process\.stdin$/, kind: 'STDIN', extractIdentity: () => 'process.stdin' },
  { pattern: /^fetch$/, kind: 'NETWORK', extractIdentity: (text) => text.replace(/^fetch\(/, '').replace(/[)'"]/g, '').trim() },
  { pattern: /^http\.request$/, kind: 'NETWORK', extractIdentity: (text) => text.replace(/^http\.request\(/, '').replace(/[)'"]/g, '').trim() },
  { pattern: /^https\.request$/, kind: 'NETWORK', extractIdentity: (text) => text.replace(/^https\.request\(/, '').replace(/[)'"]/g, '').trim() },
  { pattern: /^net\.connect$/, kind: 'SOCKET', extractIdentity: (text) => text.replace(/^net\.connect\(/, '').replace(/[)'"]/g, '').trim() },
];

// Known sink patterns: function name -> kind
const SINK_PATTERNS: Array<{ pattern: RegExp; kind: TaintSink['kind']; extractIdentity: (text: string) => string }> = [
  { pattern: /^eval$/, kind: 'ENV', extractIdentity: () => 'eval' },
  { pattern: /^Function$/, kind: 'ENV', extractIdentity: () => 'Function' },
  { pattern: /^exec$/, kind: 'SOCKET', extractIdentity: (t) => t },
  { pattern: /^execSync$/, kind: 'SOCKET', extractIdentity: (t) => t },
  { pattern: /^execFile$/, kind: 'SOCKET', extractIdentity: (t) => t },
  { pattern: /^spawn$/, kind: 'SOCKET', extractIdentity: (t) => t },
  { pattern: /^child_process\.exec$/, kind: 'SOCKET', extractIdentity: (t) => t },
  { pattern: /^child_process\.spawn$/, kind: 'SOCKET', extractIdentity: (t) => t },
  { pattern: /^query$/, kind: 'DATABASE', extractIdentity: (t) => t },
  { pattern: /^execute$/, kind: 'DATABASE', extractIdentity: (t) => t },
  { pattern: /^send$/, kind: 'NETWORK', extractIdentity: (t) => t },
  { pattern: /^write$/, kind: 'FILE', extractIdentity: (t) => t },
  { pattern: /^writeFile$/, kind: 'FILE', extractIdentity: (t) => t },
  { pattern: /^writeFileSync$/, kind: 'FILE', extractIdentity: (t) => t },
  { pattern: /^createWriteStream$/, kind: 'FILE', extractIdentity: (t) => t },
];

/**
 * Classify a sink call expression to determine its resource kind and identity.
 * Returns null if the call is not a recognized sink.
 */

export class TaintAnalyzer {
  constructor(private kg: KnowledgeGraph) {}

  /**
   * Analyze a file for taint flows. Reads file content and delegates to analyzeSource.
   */
  analyze(filePath: string, fileStructure: FileStructure): TaintFlow[] {
    if (fileStructure.language !== 'typescript' && fileStructure.language !== 'javascript') {
      return [];
    }

    try {
      const content = readFileSync(filePath, 'utf-8');
      return this.analyzeSource(filePath, content, fileStructure.language);
    } catch {
      return [];
    }
  }

  analyzeSource(filePath: string, content: string, language: 'typescript' | 'javascript'): TaintFlow[] {
    if (language !== 'typescript' && language !== 'javascript') {
      return [];
    }

    const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
    const flows: TaintFlow[] = [];
    const variables = new Map<string, TaintSource>();
    // Inter-procedural seeds: "fnName.paramName" -> taint passed by callers.
    const parameterTaint = new Map<string, TaintSource>();
    // Local function registry for same-file propagation (v1 scope).
    const localFns = new Map<string, { node: ts.Node; params: string[] }>();

    const getQualifiedName = (node: ts.Node): string => {
      if (ts.isIdentifier(node)) {
        return node.text;
      }
      if (ts.isPropertyAccessExpression(node)) {
        return `${getQualifiedName(node.expression)}.${node.name.text}`;
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        return `${getQualifiedName(node.expression)}`;
      }
      return node.getText(sourceFile);
    };

    const classifySource = (text: string): TaintSource | undefined => {
      for (const { pattern, kind, extractIdentity } of SOURCE_PATTERNS) {
        const match = text.match(pattern);
        if (match) {
          const identity = extractIdentity(text);
          return { kind, qualifiedName: match[0]!, identity, node: sourceFile };
        }
      }
      return undefined;
    };

    const isSink = (text: string): { kind: TaintSink['kind']; identity: string } | null => {
      for (const { pattern, kind, extractIdentity } of SINK_PATTERNS) {
        if (pattern.test(text)) {
          return { kind, identity: extractIdentity(text) };
        }
      }
      return null;
    };

    const extractIdentityFromInit = (initNode: ts.Node, source: TaintSource): string => {
      if (ts.isCallExpression(initNode) && initNode.arguments.length > 0) {
        return initNode.arguments[0]!.getText(sourceFile).replace(/[)'"]/g, '').trim();
      }
      if (ts.isPropertyAccessExpression(initNode)) {
        return initNode.name.text;
      }
      return source.identity;
    };

    const extractIdentityFromCall = (callNode: ts.CallExpression, source: TaintSource): string => {
      if (callNode.arguments.length > 0) {
        return callNode.arguments[0]!.getText(sourceFile).replace(/[)'"]/g, '').trim();
      }
      return source.identity;
    };

    const visit = (node: ts.Node, currentFunctionName: string | undefined): void => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const initNode = node.initializer;
        const calleeText = getQualifiedName(initNode);
        const source = classifySource(calleeText);
        if (source && node.name) {
          const identity = extractIdentityFromInit(initNode, source);
          variables.set(node.name.getText(sourceFile), { ...source, identity, node });
        }
      }

      if (ts.isCallExpression(node)) {
        const calleeText = getQualifiedName(node.expression);
        const source = classifySource(calleeText);
        if (source) {
          const identity = extractIdentityFromCall(node, source);
          const argNames = node.arguments.map((a) => a.getText(sourceFile));
          for (const arg of argNames) {
            const varSource = variables.get(arg);
            if (varSource) {
              flows.push({
                source: { ...varSource, identity },
                sink: { qualifiedName: calleeText, kind: source.kind, identity: calleeText, node },
                viaFunction: currentFunctionName,
              });
            }
          }
        }

        // Inter-procedural seed: tainted argument flowing into a LOCAL function.
        if (calleeText && !calleeText.includes('.') && !calleeText.includes('(')) {
          const fn = localFns.get(calleeText);
          if (fn) {
            node.arguments.forEach((arg, idx) => {
              const varSource = variables.get(arg.getText(sourceFile));
              const paramName = fn.params[idx];
              if (varSource && paramName && !parameterTaint.has(`${calleeText}.${paramName}`)) {
                parameterTaint.set(`${calleeText}.${paramName}`, varSource);
              }
            });
          }
        }

        const sinkInfo = isSink(calleeText);
        if (sinkInfo) {
          const argNames = node.arguments.map((a) => a.getText(sourceFile));
          for (const arg of argNames) {
            const varSource = variables.get(arg);
            if (varSource) {
              flows.push({
                source: varSource,
                sink: { qualifiedName: calleeText, kind: sinkInfo.kind, identity: sinkInfo.identity, node },
                viaFunction: currentFunctionName,
              });
            }
          }
        }
      }

      ts.forEachChild(node, (child) => visit(child, currentFunctionName));
    };

    // Collect local functions BEFORE the main pass so call sites can seed them.
    ts.forEachChild(sourceFile, function collect(n: ts.Node): void {
      if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name) {
        localFns.set(n.name.getText(sourceFile), {
          node: n,
          params: n.parameters.map((p) => (p.name && ts.isIdentifier(p.name) ? p.name.text : '')),
        });
      }
      ts.forEachChild(n, collect);
    });

    for (const statement of sourceFile.statements) {
      if (ts.isFunctionDeclaration(statement) || ts.isMethodDeclaration(statement)) {
        const fnName = statement.name?.getText(sourceFile);
        visit(statement, fnName);
      } else {
        visit(statement, undefined);
      }
    }

    // Inter-procedural pass (v1, single hop): re-scan each local function that
    // received tainted arguments from ANY call site discovered above. Newly
    // surfaced sink flows are tagged with the callee chain.
    for (const [fnName, fn] of localFns) {
      const seeds = fn.params
        .map((p) => ({ p, src: parameterTaint.get(`${fnName}.${p}`) }))
        .filter((s): s is { p: string; src: TaintSource } => !!s.src);
      if (seeds.length === 0) continue;

      for (const s of seeds) variables.set(s.p, s.src);
      const before = flows.length;
      ts.forEachChild(fn.node, (child) => visit(child, fnName));
      for (let i = before; i < flows.length; i++) {
        flows[i] = { ...flows[i], viaFunction: `${fnName} → ${flows[i].viaFunction ?? '(body)'}` };
      }
      // Unseed to keep subsequent functions independent.
      for (const s of seeds) variables.delete(s.p);
    }

    return flows;
  }

  recordFlows(filePath: string, content: string, language: 'typescript' | 'javascript'): number {
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
        // skip duplicate/invalid flows
      }
    }
    return recorded;
  }
}
