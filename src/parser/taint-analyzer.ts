import ts from 'typescript';
import { readFileSync } from 'node:fs';
import type { FileStructure } from './ast-parser.js';
import { KnowledgeGraph } from '../storage/knowledge-graph.js';
import {
  createLangParser,
  type LangSyntaxNode,
  type StructuralLanguage,
} from './language-service.js';
import { sanitizeIdentity } from './taint-utils.js';

export interface TaintSource {
  kind: 'FILE' | 'NETWORK' | 'DATABASE' | 'ENV' | 'STDIN' | 'STDOUT' | 'STDERR' | 'SOCKET';
  qualifiedName: string;
  identity: string;
  node: ts.Node | LangSyntaxNode;
}

export interface TaintSink {
  qualifiedName: string;
  kind: 'FILE' | 'NETWORK' | 'DATABASE' | 'ENV' | 'STDIN' | 'STDOUT' | 'STDERR' | 'SOCKET';
  identity: string;
  node: ts.Node | LangSyntaxNode;
}

export type TaintPathNodeType = 'source' | 'sink' | 'intermediate';

export interface TaintPathNode {
  node: ts.Node | LangSyntaxNode;
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

// Known source patterns: module.function or function name -> kind
const SOURCE_PATTERNS: Array<{
  pattern: RegExp;
  kind: TaintSource['kind'];
  extractIdentity: (text: string) => string;
  languages?: string[];
}> = [
  // TypeScript/JavaScript
  {
    pattern: /^fs\.readFile(Sync)?$/,
    kind: 'FILE',
    extractIdentity: (text) =>
      sanitizeIdentity(text.replace(/^fs\.readFile(Sync)?\(/, '').replace(/[)'"]/g, '')),
    languages: ['typescript', 'javascript'],
  },
  {
    pattern: /^fs\.createReadStream$/,
    kind: 'FILE',
    extractIdentity: (text) =>
      sanitizeIdentity(text.replace(/^fs\.createReadStream\(/, '').replace(/[)'"]/g, '')),
    languages: ['typescript', 'javascript'],
  },
  {
    pattern: /^process\.env$/,
    kind: 'ENV',
    extractIdentity: (text) => sanitizeIdentity(text.replace(/^process\.env\./, '')),
    languages: ['typescript', 'javascript'],
  },
  {
    pattern: /^process\.stdin$/,
    kind: 'STDIN',
    extractIdentity: () => 'process.stdin',
    languages: ['typescript', 'javascript'],
  },
  {
    pattern: /^fetch$/,
    kind: 'NETWORK',
    extractIdentity: (text) => sanitizeIdentity(text.replace(/^fetch\(/, '').replace(/[)'"]/g, '')),
    languages: ['typescript', 'javascript'],
  },
  {
    pattern: /^http\.request$/,
    kind: 'NETWORK',
    extractIdentity: (text) =>
      sanitizeIdentity(text.replace(/^http\.request\(/, '').replace(/[)'"]/g, '')),
    languages: ['typescript', 'javascript'],
  },
  {
    pattern: /^https\.request$/,
    kind: 'NETWORK',
    extractIdentity: (text) =>
      sanitizeIdentity(text.replace(/^https\.request\(/, '').replace(/[)'"]/g, '')),
    languages: ['typescript', 'javascript'],
  },
  {
    pattern: /^net\.connect$/,
    kind: 'SOCKET',
    extractIdentity: (text) =>
      sanitizeIdentity(text.replace(/^net\.connect\(/, '').replace(/[)'"]/g, '')),
    languages: ['typescript', 'javascript'],
  },

  // Python
  {
    pattern: /^open$/,
    kind: 'FILE',
    extractIdentity: (text) => sanitizeIdentity(text.replace(/^open\(/, '').replace(/[)'"]/g, '')),
    languages: ['python'],
  },
  {
    pattern: /^os\.environ$/,
    kind: 'ENV',
    extractIdentity: (text) =>
      sanitizeIdentity(text.replace(/^os\.environ\[/, '').replace(/[\]'"]/g, '')),
    languages: ['python'],
  },
  {
    pattern: /^sys\.stdin$/,
    kind: 'STDIN',
    extractIdentity: () => 'sys.stdin',
    languages: ['python'],
  },
  {
    pattern: /^requests\.get$/,
    kind: 'NETWORK',
    extractIdentity: (text) =>
      sanitizeIdentity(text.replace(/^requests\.get\(/, '').replace(/[)'"]/g, '')),
    languages: ['python'],
  },
  {
    pattern: /^requests\.post$/,
    kind: 'NETWORK',
    extractIdentity: (text) =>
      sanitizeIdentity(text.replace(/^requests\.post\(/, '').replace(/[)'"]/g, '')),
    languages: ['python'],
  },
  {
    pattern: /^subprocess\.run$/,
    kind: 'SOCKET',
    extractIdentity: (text) =>
      sanitizeIdentity(text.replace(/^subprocess\.run\(/, '').replace(/[)'"]/g, '')),
    languages: ['python'],
  },

  // Go
  {
    pattern: /^os\.Open$/,
    kind: 'FILE',
    extractIdentity: (text) =>
      sanitizeIdentity(text.replace(/^os\.Open\(/, '').replace(/[)'"]/g, '')),
    languages: ['go'],
  },
  {
    pattern: /^os\.Getenv$/,
    kind: 'ENV',
    extractIdentity: (text) =>
      sanitizeIdentity(text.replace(/^os\.Getenv\(/, '').replace(/[)'"]/g, '')),
    languages: ['go'],
  },
  {
    pattern: /^http\.Get$/,
    kind: 'NETWORK',
    extractIdentity: (text) =>
      sanitizeIdentity(text.replace(/^http\.Get\(/, '').replace(/[)'"]/g, '')),
    languages: ['go'],
  },
  {
    pattern: /^http\.Post$/,
    kind: 'NETWORK',
    extractIdentity: (text) =>
      sanitizeIdentity(text.replace(/^http\.Post\(/, '').replace(/[)'"]/g, '')),
    languages: ['go'],
  },
  {
    pattern: /^exec\.Command$/,
    kind: 'SOCKET',
    extractIdentity: (text) =>
      sanitizeIdentity(text.replace(/^exec\.Command\(/, '').replace(/[)'"]/g, '')),
    languages: ['go'],
  },

  // Rust
  {
    pattern: /^std::fs::File::open$/,
    kind: 'FILE',
    extractIdentity: (text) =>
      sanitizeIdentity(text.replace(/^std::fs::File::open\(/, '').replace(/[)'"]/g, '')),
    languages: ['rust'],
  },
  {
    pattern: /^std::env::var$/,
    kind: 'ENV',
    extractIdentity: (text) =>
      sanitizeIdentity(text.replace(/^std::env::var\(/, '').replace(/[)'"]/g, '')),
    languages: ['rust'],
  },
  {
    pattern: /^reqwest::get$/,
    kind: 'NETWORK',
    extractIdentity: (text) =>
      sanitizeIdentity(text.replace(/^reqwest::get\(/, '').replace(/[)'"]/g, '')),
    languages: ['rust'],
  },
  {
    pattern: /^std::process::Command::new$/,
    kind: 'SOCKET',
    extractIdentity: (text) =>
      sanitizeIdentity(text.replace(/^std::process::Command::new\(/, '').replace(/[)'"]/g, '')),
    languages: ['rust'],
  },

  // Java
  {
    pattern: /^Files\.readAllBytes$/,
    kind: 'FILE',
    extractIdentity: (text) =>
      sanitizeIdentity(text.replace(/^Files\.readAllBytes\(/, '').replace(/[)'"]/g, '')),
    languages: ['java'],
  },
  {
    pattern: /^System\.getenv$/,
    kind: 'ENV',
    extractIdentity: (text) =>
      sanitizeIdentity(text.replace(/^System\.getenv\(/, '').replace(/[)'"]/g, '')),
    languages: ['java'],
  },
  {
    pattern: /^System\.in$/,
    kind: 'STDIN',
    extractIdentity: () => 'System.in',
    languages: ['java'],
  },
  {
    pattern: /^HttpClient\.newHttpClient$/,
    kind: 'NETWORK',
    extractIdentity: () => 'HttpClient',
    languages: ['java'],
  },
  // `Runtime.getRuntime().exec(...)` may render as either `getRuntime().exec` or
  // (after AGENT name normalization) `getRuntime.exec` — accept both forms.
  {
    pattern: /^Runtime\.getRuntime(\(\))?\.exec$/,
    kind: 'SOCKET',
    extractIdentity: (text) =>
      sanitizeIdentity(
        text.replace(/^Runtime\.getRuntime(\(\))?\.exec\(/, '').replace(/[)'"]/g, ''),
      ),
    languages: ['java'],
  },
];

// Known sink patterns: function name -> kind
const SINK_PATTERNS: Array<{
  pattern: RegExp;
  kind: TaintSink['kind'];
  extractIdentity: (text: string) => string;
  languages?: string[];
}> = [
  // TypeScript/JavaScript
  {
    pattern: /^eval$/,
    kind: 'ENV',
    extractIdentity: () => 'eval',
    languages: ['typescript', 'javascript'],
  },
  {
    pattern: /^Function$/,
    kind: 'ENV',
    extractIdentity: () => 'Function',
    languages: ['typescript', 'javascript'],
  },
  {
    pattern: /^exec$/,
    kind: 'SOCKET',
    extractIdentity: (t) => sanitizeIdentity(t),
    languages: ['typescript', 'javascript'],
  },
  {
    pattern: /^execSync$/,
    kind: 'SOCKET',
    extractIdentity: (t) => sanitizeIdentity(t),
    languages: ['typescript', 'javascript'],
  },
  {
    pattern: /^execFile$/,
    kind: 'SOCKET',
    extractIdentity: (t) => sanitizeIdentity(t),
    languages: ['typescript', 'javascript'],
  },
  {
    pattern: /^spawn$/,
    kind: 'SOCKET',
    extractIdentity: (t) => sanitizeIdentity(t),
    languages: ['typescript', 'javascript'],
  },
  {
    pattern: /^child_process\.exec$/,
    kind: 'SOCKET',
    extractIdentity: (t) => sanitizeIdentity(t),
    languages: ['typescript', 'javascript'],
  },
  {
    pattern: /^child_process\.spawn$/,
    kind: 'SOCKET',
    extractIdentity: (t) => sanitizeIdentity(t),
    languages: ['typescript', 'javascript'],
  },
  {
    pattern: /^query$/,
    kind: 'DATABASE',
    extractIdentity: (t) => sanitizeIdentity(t),
    languages: ['typescript', 'javascript'],
  },
  {
    pattern: /^execute$/,
    kind: 'DATABASE',
    extractIdentity: (t) => sanitizeIdentity(t),
    languages: ['typescript', 'javascript'],
  },
  {
    pattern: /^send$/,
    kind: 'NETWORK',
    extractIdentity: (t) => sanitizeIdentity(t),
    languages: ['typescript', 'javascript'],
  },
  {
    pattern: /^write$/,
    kind: 'FILE',
    extractIdentity: (t) => sanitizeIdentity(t),
    languages: ['typescript', 'javascript'],
  },
  {
    pattern: /^writeFile$/,
    kind: 'FILE',
    extractIdentity: (t) => sanitizeIdentity(t),
    languages: ['typescript', 'javascript'],
  },
  {
    pattern: /^writeFileSync$/,
    kind: 'FILE',
    extractIdentity: (t) => sanitizeIdentity(t),
    languages: ['typescript', 'javascript'],
  },
  {
    pattern: /^createWriteStream$/,
    kind: 'FILE',
    extractIdentity: (t) => sanitizeIdentity(t),
    languages: ['typescript', 'javascript'],
  },

  // Python
  { pattern: /^eval$/, kind: 'ENV', extractIdentity: () => 'eval', languages: ['python'] },
  { pattern: /^exec$/, kind: 'ENV', extractIdentity: () => 'exec', languages: ['python'] },
  {
    pattern: /^subprocess\.run$/,
    kind: 'SOCKET',
    extractIdentity: (t) => sanitizeIdentity(t),
    languages: ['python'],
  },
  {
    pattern: /^subprocess\.Popen$/,
    kind: 'SOCKET',
    extractIdentity: (t) => sanitizeIdentity(t),
    languages: ['python'],
  },
  {
    pattern: /^open$/,
    kind: 'FILE',
    extractIdentity: (t) => sanitizeIdentity(t),
    languages: ['python'],
  },

  // Go
  {
    pattern: /^exec\.Command$/,
    kind: 'SOCKET',
    extractIdentity: (t) => sanitizeIdentity(t),
    languages: ['go'],
  },
  {
    pattern: /^os\.Create$/,
    kind: 'FILE',
    extractIdentity: (t) => sanitizeIdentity(t),
    languages: ['go'],
  },

  // Rust
  {
    pattern: /^std::process::Command::new$/,
    kind: 'SOCKET',
    extractIdentity: (t) => sanitizeIdentity(t),
    languages: ['rust'],
  },
  {
    pattern: /^std::fs::File::create$/,
    kind: 'FILE',
    extractIdentity: (t) => sanitizeIdentity(t),
    languages: ['rust'],
  },

  // Java
  {
    pattern: /^Runtime\.getRuntime(\(\))?\.exec$/,
    kind: 'SOCKET',
    extractIdentity: (t) => sanitizeIdentity(t),
    languages: ['java'],
  },
  {
    pattern: /^Files\.write$/,
    kind: 'FILE',
    extractIdentity: (t) => sanitizeIdentity(t),
    languages: ['java'],
  },
];

/**
 * Classify a sink call expression to determine its resource kind and identity.
 * Returns null if the call is not a recognized sink.
 */

export class TaintAnalyzer {
  private static readonly SUPPORTED: readonly StructuralLanguage[] = [
    'typescript',
    'javascript',
    'python',
    'go',
    'rust',
    'java',
  ];

  constructor(private kg: KnowledgeGraph) {}

  /**
   * Analyze a file for taint flows. Reads file content and delegates to analyzeSource.
   */
  analyze(filePath: string, fileStructure: FileStructure): TaintFlow[] {
    if ((TaintAnalyzer.SUPPORTED as readonly string[]).includes(fileStructure.language)) {
      try {
        const content = readFileSync(filePath, 'utf-8');
        return this.analyzeSource(filePath, content, fileStructure.language as StructuralLanguage);
      } catch {
        return [];
      }
    }
    return [];
  }

  analyzeSource(filePath: string, content: string, language: StructuralLanguage): TaintFlow[] {
    if (!(TaintAnalyzer.SUPPORTED as readonly string[]).includes(language)) {
      return [];
    }

    if (language === 'typescript' || language === 'javascript') {
      return this.analyzeTypeScript(filePath, content, language);
    }
    return this.analyzeMultiLanguage(filePath, content, language);
  }

  // ---------------------------------------------------------------------------
  // Shared pattern matching (both analysis paths use these)
  // ---------------------------------------------------------------------------

  private matchSource(
    text: string,
    language: StructuralLanguage,
  ): { kind: TaintSource['kind']; qualifiedName: string; identity: string } | undefined {
    for (const { pattern, kind, extractIdentity, languages } of SOURCE_PATTERNS) {
      if (languages && !languages.includes(language)) continue;
      const match = text.match(pattern);
      if (match) {
        return { kind, qualifiedName: match[0]!, identity: extractIdentity(text) };
      }
    }
    return undefined;
  }

  private matchSink(
    text: string,
    language: StructuralLanguage,
  ): { kind: TaintSink['kind']; identity: string } | null {
    for (const { pattern, kind, extractIdentity, languages } of SINK_PATTERNS) {
      if (languages && !languages.includes(language)) continue;
      if (pattern.test(text)) {
        return { kind, identity: extractIdentity(text) };
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // TypeScript/JavaScript path (TypeScript Compiler API)
  // ---------------------------------------------------------------------------

  private analyzeTypeScript(
    filePath: string,
    content: string,
    language: 'typescript' | 'javascript',
  ): TaintFlow[] {
    const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
    const flows: TaintFlow[] = [];
    const variables = new Map<string, TaintSource>();
    // Inter-procedural seeds: "fnName.paramName" -> taint passed by callers.
    const parameterTaint = new Map<string, TaintSource>();
    // Track paths for inter-procedural flows
    const interProceduralPaths = new Map<string, TaintPathNode[]>();
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

    const extractIdentityFromInit = (initNode: ts.Node, source: { identity: string }): string => {
      if (ts.isCallExpression(initNode) && initNode.arguments.length > 0) {
        return sanitizeIdentity(initNode.arguments[0]!.getText(sourceFile).replace(/[)'"]/g, ''));
      }
      if (ts.isPropertyAccessExpression(initNode)) {
        return sanitizeIdentity(initNode.name.text);
      }
      return sanitizeIdentity(source.identity);
    };

    const extractIdentityFromCall = (
      callNode: ts.CallExpression,
      source: { identity: string },
    ): string => {
      if (callNode.arguments.length > 0) {
        return sanitizeIdentity(callNode.arguments[0]!.getText(sourceFile).replace(/[)'"]/g, ''));
      }
      return sanitizeIdentity(source.identity);
    };

    const visit = (
      node: ts.Node,
      currentFunctionName: string | undefined,
      path: TaintPathNode[] = [],
    ): void => {
      const currentPath = [...path];

      if (ts.isVariableDeclaration(node) && node.initializer) {
        const initNode = node.initializer;
        const calleeText = sanitizeIdentity(getQualifiedName(initNode));
        const source = this.matchSource(calleeText, language);
        if (source && node.name) {
          const identity = extractIdentityFromInit(initNode, source);
          variables.set(node.name.getText(sourceFile), { ...source, identity, node });
          currentPath.push({
            node,
            type: 'source' as const,
            function: currentFunctionName,
            variable: node.name.getText(sourceFile),
          });
        }
      }

      if (ts.isCallExpression(node)) {
        const calleeText = sanitizeIdentity(getQualifiedName(node.expression));
        const source = this.matchSource(calleeText, language);
        if (source) {
          const identity = extractIdentityFromCall(node, source);
          const argNames = node.arguments.map((a) => a.getText(sourceFile));
          for (const arg of argNames) {
            const varSource = variables.get(arg);
            if (varSource) {
              const flowPath: TaintPathNode[] = [
                ...currentPath,
                {
                  node: varSource.node,
                  type: 'source' as const,
                  function: currentFunctionName,
                  variable: arg,
                },
                {
                  node,
                  type: 'intermediate' as const,
                  function: currentFunctionName,
                },
              ];
              flows.push({
                source: { ...varSource, identity },
                sink: { qualifiedName: calleeText, kind: source.kind, identity: calleeText, node },
                viaFunction: currentFunctionName,
                viaVariable: arg,
                path: flowPath,
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
                // Track the path into the function
                const flowPath: TaintPathNode[] = [
                  ...currentPath,
                  {
                    node: varSource.node,
                    type: 'source' as const,
                    function: currentFunctionName,
                    variable: arg.getText(sourceFile),
                  },
                  {
                    node: arg,
                    type: 'intermediate' as const,
                    function: currentFunctionName,
                  },
                ];
                interProceduralPaths.set(`${calleeText}.${paramName}`, flowPath);
              }
            });
          }
        }

        const sinkInfo = this.matchSink(calleeText, language);
        if (sinkInfo) {
          const argNames = node.arguments.map((a) => a.getText(sourceFile));
          for (const arg of argNames) {
            const varSource = variables.get(arg);
            if (varSource) {
              const flowPath: TaintPathNode[] = [
                ...currentPath,
                {
                  node: varSource.node,
                  type: 'source' as const,
                  function: currentFunctionName,
                  variable: arg,
                },
                {
                  node,
                  type: 'sink' as const,
                  function: currentFunctionName,
                },
              ];
              flows.push({
                source: varSource,
                sink: {
                  qualifiedName: calleeText,
                  kind: sinkInfo.kind,
                  identity: sanitizeIdentity(sinkInfo.identity),
                  node,
                },
                viaFunction: currentFunctionName,
                viaVariable: arg,
                path: flowPath,
              });
            }
          }
        }
      }

      ts.forEachChild(node, (child) => visit(child, currentFunctionName, currentPath));
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

    // Inter-procedural pass with path tracking
    for (const [fnName, fn] of localFns) {
      const seeds = fn.params
        .map((p) => ({
          p,
          src: parameterTaint.get(`${fnName}.${p}`),
          path: interProceduralPaths.get(`${fnName}.${p}`),
        }))
        .filter(
          (s): s is { p: string; src: TaintSource; path: TaintPathNode[] } => !!s.src && !!s.path,
        );

      if (seeds.length === 0) continue;

      for (const s of seeds) {
        variables.set(s.p, s.src);
        interProceduralPaths.set(`local.${s.p}`, s.path);
      }

      const before = flows.length;
      ts.forEachChild(fn.node, (child) => visit(child, fnName));

      for (let i = before; i < flows.length; i++) {
        const seed = seeds.find((s) => s.p === flows[i].viaVariable);
        if (seed) {
          flows[i] = {
            ...flows[i],
            viaFunction: `${fnName} → ${flows[i].viaFunction ?? '(body)'}`,
            path: [...seed.path, ...flows[i].path.slice(1)], // Merge paths
          };
        }
      }

      // Unseed to keep subsequent functions independent.
      for (const s of seeds) variables.delete(s.p);
    }

    return flows;
  }

  // ---------------------------------------------------------------------------
  // Python / Go / Rust / Java path (tree-sitter)
  // ---------------------------------------------------------------------------

  private analyzeMultiLanguage(
    filePath: string,
    content: string,
    language: 'python' | 'go' | 'rust' | 'java',
  ): TaintFlow[] {
    const flows: TaintFlow[] = [];
    const parsed = createLangParser(filePath, content);
    if (!parsed) return flows;
    const root = parsed.root;

    const variables = new Map<string, TaintSource>();
    // Inter-procedural seeds: "fnName.paramName" -> taint passed by callers.
    const parameterTaint = new Map<string, TaintSource>();
    // Track paths for inter-procedural flows
    const interProceduralPaths = new Map<string, TaintPathNode[]>();
    // Local function registry for same-file propagation.
    const localFns = new Map<string, { node: LangSyntaxNode; params: string[] }>();

    const isCallNode = (n: LangSyntaxNode): boolean =>
      n.type === 'call' || n.type === 'call_expression' || n.type === 'method_invocation';

    // Build a dotted identifier name from a syntax node, per language grammar.
    const getQualified = (n: LangSyntaxNode): string => {
      switch (language) {
        case 'python': {
          if (n.type === 'call') {
            const fn = n.childForFieldName('function');
            return fn ? getQualified(fn) : n.text;
          }
          if (n.type === 'attribute') {
            const obj = n.childForFieldName('object');
            const attr = n.childForFieldName('attribute');
            return (obj ? getQualified(obj) : '') + '.' + (attr?.text ?? '');
          }
          if (n.type === 'subscript') {
            const value = n.childForFieldName('value');
            return value ? getQualified(value) : n.text;
          }
          return n.text;
        }
        case 'go': {
          if (n.type === 'call_expression') {
            const fn = n.childForFieldName('function');
            return fn ? getQualified(fn) : n.text;
          }
          if (n.type === 'selector_expression') {
            const operand = n.childForFieldName('operand');
            const field = n.childForFieldName('field');
            return (operand ? getQualified(operand) : '') + '.' + (field?.text ?? '');
          }
          return n.text;
        }
        case 'rust': {
          if (n.type === 'call_expression') {
            const fn = n.childForFieldName('function');
            return fn ? getQualified(fn) : n.text;
          }
          if (n.type === 'field_expression') {
            const value = n.childForFieldName('value');
            const field = n.childForFieldName('field');
            return (value ? getQualified(value) : '') + '.' + (field?.text ?? '');
          }
          if (n.type === 'scoped_identifier' || n.type === 'scoped_type_identifier') {
            const path = n.childForFieldName('path');
            const name = n.childForFieldName('name');
            return (path ? getQualified(path) : '') + '::' + (name?.text ?? '');
          }
          return n.text;
        }
        case 'java': {
          if (n.type === 'method_invocation') {
            const name = n.childForFieldName('name');
            if (name) {
              const obj = n.childForFieldName('object');
              const objText =
                obj && obj.type !== 'this' && obj.type !== 'super' ? getQualified(obj) : undefined;
              return (objText ? objText + '.' : '') + name.text;
            }
            return n.text;
          }
          if (n.type === 'field_access') {
            const obj = n.childForFieldName('object');
            const field = n.childForFieldName('field');
            return (obj ? getQualified(obj) : '') + '.' + (field?.text ?? '');
          }
          return n.text;
        }
      }
    };

    // Descend through method-call chains like `src().unwrap()` (Rust) or
    // `src().read()` (Python) back to the base callable, so the underlying
    // source API is classified instead of the chained method name.
    const chainRoot = (n: LangSyntaxNode): LangSyntaxNode => {
      if (language !== 'python' && language !== 'rust') return n;
      let cur = n;
      while (true) {
        if (cur.type !== 'call' && cur.type !== 'call_expression') return cur;
        const fn = cur.childForFieldName('function');
        if (!fn) return cur;
        const inner =
          fn.type === 'attribute'
            ? fn.childForFieldName('object')
            : fn.type === 'field_expression'
              ? fn.childForFieldName('value')
              : undefined;
        if (!inner || (inner.type !== 'call' && inner.type !== 'call_expression')) return cur;
        cur = inner;
      }
    };

    const argNodesList = (n: LangSyntaxNode): readonly LangSyntaxNode[] => {
      const argsNode = n.childForFieldName('arguments');
      return argsNode ? argsNode.namedChildren : [];
    };

    const argList = (n: LangSyntaxNode): string[] => argNodesList(n).map((a) => a.text.trim());

    const extractFromFirstArg = (n: LangSyntaxNode): string | undefined => {
      const first = argNodesList(n)[0];
      if (!first) return undefined;
      return sanitizeIdentity(first.text.replace(/^['"]|['"]$/g, ''));
    };

    const identityFromInit = (init: LangSyntaxNode, source: TaintSource): string => {
      if (isCallNode(init)) {
        return extractFromFirstArg(init) ?? sanitizeIdentity(source.identity);
      }
      if (init.type === 'subscript') {
        const idx = init.childForFieldName('subscript');
        return idx
          ? sanitizeIdentity(idx.text.replace(/^['"]|['"]$/g, ''))
          : sanitizeIdentity(source.identity);
      }
      if (init.type === 'attribute') {
        return sanitizeIdentity(init.childForFieldName('attribute')?.text ?? source.identity);
      }
      if (init.type === 'field_access') {
        return sanitizeIdentity(init.childForFieldName('field')?.text ?? source.identity);
      }
      return sanitizeIdentity(source.identity);
    };

    // Extract a single-name variable declaration from a node, per language grammar.
    const declInfo = (n: LangSyntaxNode): { name: string; init: LangSyntaxNode } | null => {
      switch (language) {
        case 'python': {
          if (n.type !== 'assignment') return null;
          const left = n.childForFieldName('left');
          const right = n.childForFieldName('right');
          if (!left || !right || left.type !== 'identifier') return null;
          return { name: left.text, init: right };
        }
        case 'go': {
          if (n.type !== 'short_var_declaration' && n.type !== 'assignment_statement') return null;
          const left = n.childForFieldName('left');
          const right = n.childForFieldName('right');
          if (!left || !right) return null;
          const single = left.type === 'expression_list' ? left.namedChildren[0] : left;
          if (!single || single.type !== 'identifier') return null;
          // Go wraps single expressions in expression_list nodes; unwrap so the
          // initializer is the actual call/expression instead of the wrapper.
          const initValue =
            right.type === 'expression_list' ? (right.namedChildren[0] ?? right) : right;
          return { name: single.text, init: initValue };
        }
        case 'rust': {
          if (n.type !== 'let_declaration') return null;
          const pattern = n.childForFieldName('pattern');
          const value = n.childForFieldName('value');
          if (!pattern || !value) return null;
          const ident =
            pattern.type === 'identifier'
              ? pattern
              : pattern.type === 'tuple_pattern' &&
                  pattern.namedChildren.length === 1 &&
                  pattern.namedChildren[0]?.type === 'identifier'
                ? pattern.namedChildren[0]!
                : undefined;
          if (!ident) return null;
          return { name: ident.text, init: value };
        }
        case 'java': {
          if (n.type === 'local_variable_declaration') {
            const declarator = n.childForFieldName('declarator');
            if (!declarator) return null;
            const name = declarator.childForFieldName('name');
            const value = declarator.childForFieldName('value');
            if (!name || !value) return null;
            return { name: name.text, init: value };
          }
          if (n.type === 'assignment_expression') {
            const left = n.childForFieldName('left');
            const right = n.childForFieldName('right');
            if (!left || !right || left.type !== 'identifier') return null;
            return { name: left.text, init: right };
          }
          return null;
        }
      }
    };

    // Function definition node kinds per language.
    const fnKinds = new Set<string>([
      'function_definition',
      'function_declaration',
      'method_declaration',
      'function_item',
    ]);

    const fnParams = (n: LangSyntaxNode): string[] => {
      const paramsNode = n.childForFieldName('parameters');
      if (!paramsNode) return [];
      const walk = (p: LangSyntaxNode): string | undefined => {
        if (p.type === 'identifier') return p.text;
        const name = p.childForFieldName('name');
        if (name) return name.text;
        const pattern = p.childForFieldName('pattern');
        if (pattern) return pattern.type === 'identifier' ? pattern.text : undefined;
        return undefined;
      };
      return paramsNode.namedChildren.map(walk).filter((x): x is string => x !== undefined);
    };

    const visit = (
      n: LangSyntaxNode,
      currentFunctionName: string | undefined,
      path: TaintPathNode[] = [],
    ): void => {
      const currentPath = [...path];

      // Variable declarations initialize taint.
      const decl = declInfo(n);
      if (decl) {
        const calleeText = sanitizeIdentity(getQualified(chainRoot(decl.init)));
        const source = this.matchSource(calleeText, language);
        if (source) {
          const src: TaintSource = { ...source, node: decl.init };
          const identity = identityFromInit(chainRoot(decl.init), src);
          variables.set(decl.name, { ...src, identity });
          currentPath.push({
            node: decl.init,
            type: 'source' as const,
            function: currentFunctionName,
            variable: decl.name,
          });
        }
      }

      if (isCallNode(n)) {
        const calleeText = sanitizeIdentity(getQualified(chainRoot(n)));
        const bareName: string | undefined =
          calleeText &&
          !calleeText.includes('.') &&
          !calleeText.includes('(') &&
          !calleeText.includes(':')
            ? calleeText
            : undefined;

        // Source call site: a tainted variable passed INTO a known source API.
        const source = this.matchSource(calleeText, language);
        if (source) {
          const identity = extractFromFirstArg(n) ?? source.identity;
          for (const arg of argList(n)) {
            const varSource = variables.get(arg);
            if (varSource) {
              flows.push({
                source: { ...varSource, identity },
                sink: {
                  qualifiedName: calleeText,
                  kind: source.kind,
                  identity: calleeText,
                  node: n,
                },
                viaFunction: currentFunctionName,
                viaVariable: arg,
                path: [
                  ...currentPath,
                  {
                    node: varSource.node,
                    type: 'source' as const,
                    function: currentFunctionName,
                    variable: arg,
                  },
                  { node: n, type: 'intermediate' as const, function: currentFunctionName },
                ],
              });
            }
          }
        }

        // Inter-procedural seed: tainted argument flowing into a LOCAL function.
        if (bareName) {
          const fn = localFns.get(bareName);
          if (fn) {
            argNodesList(n).forEach((argNode, idx) => {
              const arg = argNode.text.trim();
              const varSource = variables.get(arg);
              const paramName = fn.params[idx];
              if (varSource && paramName && !parameterTaint.has(`${bareName}.${paramName}`)) {
                parameterTaint.set(`${bareName}.${paramName}`, varSource);
                interProceduralPaths.set(`${bareName}.${paramName}`, [
                  ...currentPath,
                  {
                    node: varSource.node,
                    type: 'source' as const,
                    function: currentFunctionName,
                    variable: arg,
                  },
                  { node: argNode, type: 'intermediate' as const, function: currentFunctionName },
                ]);
              }
            });
          }
        }

        // Sink call site.
        const sinkInfo = this.matchSink(calleeText, language);
        if (sinkInfo) {
          for (const arg of argList(n)) {
            const varSource = variables.get(arg);
            if (varSource) {
              flows.push({
                source: varSource,
                sink: {
                  qualifiedName: calleeText,
                  kind: sinkInfo.kind,
                  identity: sanitizeIdentity(sinkInfo.identity),
                  node: n,
                },
                viaFunction: currentFunctionName,
                viaVariable: arg,
                path: [
                  ...currentPath,
                  {
                    node: varSource.node,
                    type: 'source' as const,
                    function: currentFunctionName,
                    variable: arg,
                  },
                  { node: n, type: 'sink' as const, function: currentFunctionName },
                ],
              });
            }
          }
        }
      }

      const fnName = fnKinds.has(n.type) ? n.childForFieldName('name')?.text : undefined;
      for (const child of n.namedChildren) {
        visit(child, fnName ?? currentFunctionName, currentPath);
      }
    };

    // Collect local functions BEFORE the main pass so call sites can seed them.
    const collect = (n: LangSyntaxNode): void => {
      if (fnKinds.has(n.type)) {
        const name = n.childForFieldName('name');
        if (name) localFns.set(name.text, { node: n, params: fnParams(n) });
      }
      for (const child of n.namedChildren) collect(child);
    };
    collect(root);

    visit(root, undefined);

    // Inter-procedural pass with path tracking.
    for (const [fnName, fn] of localFns) {
      const seeds = fn.params
        .map((p) => ({
          p,
          src: parameterTaint.get(`${fnName}.${p}`),
          path: interProceduralPaths.get(`${fnName}.${p}`),
        }))
        .filter(
          (s): s is { p: string; src: TaintSource; path: TaintPathNode[] } => !!s.src && !!s.path,
        );

      if (seeds.length === 0) continue;

      for (const s of seeds) {
        variables.set(s.p, s.src);
        interProceduralPaths.set(`local.${s.p}`, s.path);
      }

      const before = flows.length;
      for (const child of fn.node.namedChildren) visit(child, fnName);

      for (let i = before; i < flows.length; i++) {
        const seed = seeds.find((s) => s.p === flows[i].viaVariable);
        if (seed) {
          flows[i] = {
            ...flows[i],
            viaFunction: `${fnName} → ${flows[i].viaFunction ?? '(body)'}`,
            path: [...seed.path, ...flows[i].path.slice(1)], // Merge paths
          };
        }
      }

      // Unseed to keep subsequent functions independent.
      for (const s of seeds) variables.delete(s.p);
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
        // skip duplicate/invalid flows
      }
    }
    return recorded;
  }
}
