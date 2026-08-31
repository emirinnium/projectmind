import ts from 'typescript';
import { readFileSync } from 'node:fs';
import type { FileStructure } from './ast-parser.js';
import { KnowledgeGraph } from '../storage/knowledge-graph.js';
import { createLangParser, type LangSyntaxNode, type StructuralLanguage } from './language-service.js';
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
const SOURCE_PATTERNS: Array<{ pattern: RegExp; kind: TaintSource['kind']; extractIdentity: (text: string) => string; languages?: string[] }> = [
  // TypeScript/JavaScript
  { pattern: /^fs\.readFile(Sync)?$/, kind: 'FILE', extractIdentity: (text) => sanitizeIdentity(text.replace(/^fs\.readFile(Sync)?\(/, '').replace(/[)'"]/g, '')), languages: ['typescript', 'javascript'] },
  { pattern: /^fs\.createReadStream$/, kind: 'FILE', extractIdentity: (text) => sanitizeIdentity(text.replace(/^fs\.createReadStream\(/, '').replace(/[)'"]/g, '')), languages: ['typescript', 'javascript'] },
  { pattern: /^process\.env$/, kind: 'ENV', extractIdentity: (text) => sanitizeIdentity(text.replace(/^process\.env\./, '')), languages: ['typescript', 'javascript'] },
  { pattern: /^process\.stdin$/, kind: 'STDIN', extractIdentity: () => 'process.stdin', languages: ['typescript', 'javascript'] },
  { pattern: /^fetch$/, kind: 'NETWORK', extractIdentity: (text) => sanitizeIdentity(text.replace(/^fetch\(/, '').replace(/[)'"]/g, '')), languages: ['typescript', 'javascript'] },
  { pattern: /^http\.request$/, kind: 'NETWORK', extractIdentity: (text) => sanitizeIdentity(text.replace(/^http\.request\(/, '').replace(/[)'"]/g, '')), languages: ['typescript', 'javascript'] },
  { pattern: /^https\.request$/, kind: 'NETWORK', extractIdentity: (text) => sanitizeIdentity(text.replace(/^https\.request\(/, '').replace(/[)'"]/g, '')), languages: ['typescript', 'javascript'] },
  { pattern: /^net\.connect$/, kind: 'SOCKET', extractIdentity: (text) => sanitizeIdentity(text.replace(/^net\.connect\(/, '').replace(/[)'"]/g, '')), languages: ['typescript', 'javascript'] },

  // Python
  { pattern: /^open$/, kind: 'FILE', extractIdentity: (text) => sanitizeIdentity(text.replace(/^open\(/, '').replace(/[)'"]/g, '')), languages: ['python'] },
  { pattern: /^os\.environ$/, kind: 'ENV', extractIdentity: (text) => sanitizeIdentity(text.replace(/^os\.environ\[/, '').replace(/[\]'"]/g, '')), languages: ['python'] },
  { pattern: /^sys\.stdin$/, kind: 'STDIN', extractIdentity: () => 'sys.stdin', languages: ['python'] },
  { pattern: /^requests\.get$/, kind: 'NETWORK', extractIdentity: (text) => sanitizeIdentity(text.replace(/^requests\.get\(/, '').replace(/[)'"]/g, '')), languages: ['python'] },
  { pattern: /^requests\.post$/, kind: 'NETWORK', extractIdentity: (text) => sanitizeIdentity(text.replace(/^requests\.post\(/, '').replace(/[)'"]/g, '')), languages: ['python'] },
  { pattern: /^subprocess\.run$/, kind: 'SOCKET', extractIdentity: (text) => sanitizeIdentity(text.replace(/^subprocess\.run\(/, '').replace(/[)'"]/g, '')), languages: ['python'] },

  // Go
  { pattern: /^os\.Open$/, kind: 'FILE', extractIdentity: (text) => sanitizeIdentity(text.replace(/^os\.Open\(/, '').replace(/[)'"]/g, '')), languages: ['go'] },
  { pattern: /^os\.Getenv$/, kind: 'ENV', extractIdentity: (text) => sanitizeIdentity(text.replace(/^os\.Getenv\(/, '').replace(/[)'"]/g, '')), languages: ['go'] },
  { pattern: /^http\.Get$/, kind: 'NETWORK', extractIdentity: (text) => sanitizeIdentity(text.replace(/^http\.Get\(/, '').replace(/[)'"]/g, '')), languages: ['go'] },
  { pattern: /^http\.Post$/, kind: 'NETWORK', extractIdentity: (text) => sanitizeIdentity(text.replace(/^http\.Post\(/, '').replace(/[)'"]/g, '')), languages: ['go'] },
  { pattern: /^exec\.Command$/, kind: 'SOCKET', extractIdentity: (text) => sanitizeIdentity(text.replace(/^exec\.Command\(/, '').replace(/[)'"]/g, '')), languages: ['go'] },

  // Rust
  { pattern: /^std::fs::File::open$/, kind: 'FILE', extractIdentity: (text) => sanitizeIdentity(text.replace(/^std::fs::File::open\(/, '').replace(/[)'"]/g, '')), languages: ['rust'] },
  { pattern: /^std::env::var$/, kind: 'ENV', extractIdentity: (text) => sanitizeIdentity(text.replace(/^std::env::var\(/, '').replace(/[)'"]/g, '')), languages: ['rust'] },
  { pattern: /^reqwest::get$/, kind: 'NETWORK', extractIdentity: (text) => sanitizeIdentity(text.replace(/^reqwest::get\(/, '').replace(/[)'"]/g, '')), languages: ['rust'] },
  { pattern: /^std::process::Command::new$/, kind: 'SOCKET', extractIdentity: (text) => sanitizeIdentity(text.replace(/^std::process::Command::new\(/, '').replace(/[)'"]/g, '')), languages: ['rust'] },

  // Java
  { pattern: /^Files\.readAllBytes$/, kind: 'FILE', extractIdentity: (text) => sanitizeIdentity(text.replace(/^Files\.readAllBytes\(/, '').replace(/[)'"]/g, '')), languages: ['java'] },
  { pattern: /^System\.getenv$/, kind: 'ENV', extractIdentity: (text) => sanitizeIdentity(text.replace(/^System\.getenv\(/, '').replace(/[)'"]/g, '')), languages: ['java'] },
  { pattern: /^System\.in$/, kind: 'STDIN', extractIdentity: () => 'System.in', languages: ['java'] },
  { pattern: /^HttpClient\.newHttpClient$/, kind: 'NETWORK', extractIdentity: () => 'HttpClient', languages: ['java'] },
  // `Runtime.getRuntime().exec(...)` may render as either `getRuntime().exec` or
  // (after AGENT name normalization) `getRuntime.exec` — accept both forms.
  { pattern: /^Runtime\.getRuntime(\(\))?\.exec$/, kind: 'SOCKET', extractIdentity: (text) => sanitizeIdentity(text.replace(/^Runtime\.getRuntime(\(\))?\.exec\(/, '').replace(/[)'"]/g, '')), languages: ['java'] },
];

// Known sink patterns: function name -> kind
const SINK_PATTERNS: Array<{ pattern: RegExp; kind: TaintSink['kind']; extractIdentity: (text: string) => string; languages?: string[] }> = [
  // TypeScript/JavaScript
  { pattern: /^eval$/, kind: 'ENV', extractIdentity: () => 'eval', languages: ['typescript', 'javascript'] },
  { pattern: /^Function$/, kind: 'ENV', extractIdentity: () => 'Function', languages: ['typescript', 'javascript'] },
  { pattern: /^exec$/, kind: 'SOCKET', extractIdentity: (t) => sanitizeIdentity(t), languages: ['typescript', 'javascript'] },
  { pattern: /^execSync$/, kind: 'SOCKET', extractIdentity: (t) => sanitizeIdentity(t), languages: ['typescript', 'javascript'] },
  { pattern: /^execFile$/, kind: 'SOCKET', extractIdentity: (t) => sanitizeIdentity(t), languages: ['typescript', 'javascript'] },
  { pattern: /^spawn$/, kind: 'SOCKET', extractIdentity: (t) => sanitizeIdentity(t), languages: ['typescript', 'javascript'] },
  { pattern: /^child_process\.exec$/, kind: 'SOCKET', extractIdentity: (t) => sanitizeIdentity(t), languages: ['typescript', 'javascript'] },
  { pattern: /^child_process\.spawn$/, kind: 'SOCKET', extractIdentity: (t) => sanitizeIdentity(t), languages: ['typescript', 'javascript'] },
  { pattern: /^query$/, kind: 'DATABASE', extractIdentity: (t) => sanitizeIdentity(t), languages: ['typescript', 'javascript'] },
  { pattern: /^execute$/, kind: 'DATABASE', extractIdentity: (t) => sanitizeIdentity(t), languages: ['typescript', 'javascript'] },
  { pattern: /^send$/, kind: 'NETWORK', extractIdentity: (t) => sanitizeIdentity(t), languages: ['typescript', 'javascript'] },
  { pattern: /^write$/, kind: 'FILE', extractIdentity: (t) => sanitizeIdentity(t), languages: ['typescript', 'javascript'] },
  { pattern: /^writeFile$/, kind: 'FILE', extractIdentity: (t) => sanitizeIdentity(t), languages: ['typescript', 'javascript'] },
  { pattern: /^writeFileSync$/, kind: 'FILE', extractIdentity: (t) => sanitizeIdentity(t), languages: ['typescript', 'javascript'] },
  { pattern: /^createWriteStream$/, kind: 'FILE', extractIdentity: (t) => sanitizeIdentity(t), languages: ['typescript', 'javascript'] },

  // Python
  { pattern: /^eval$/, kind: 'ENV', extractIdentity: () => 'eval', languages: ['python'] },
  { pattern: /^exec$/, kind: 'ENV', extractIdentity: () => 'exec', languages: ['python'] },
  { pattern: /^subprocess\.run$/, kind: 'SOCKET', extractIdentity: (t) => sanitizeIdentity(t), languages: ['python'] },
  { pattern: /^subprocess\.Popen$/, kind: 'SOCKET', extractIdentity: (t) => sanitizeIdentity(t), languages: ['python'] },
  { pattern: /^open$/, kind: 'FILE', extractIdentity: (t) => sanitizeIdentity(t), languages: ['python'] },

  // Go
  { pattern: /^exec\.Command$/, kind: 'SOCKET', extractIdentity: (t) => sanitizeIdentity(t), languages: ['go'] },
  { pattern: /^os\.Create$/, kind: 'FILE', extractIdentity: (t) => sanitizeIdentity(t), languages: ['go'] },

  // Rust
  { pattern: /^std::process::Command::new$/, kind: 'SOCKET', extractIdentity: (t) => sanitizeIdentity(t), languages: ['rust'] },
  { pattern: /^std::fs::File::create$/, kind: 'FILE', extractIdentity: (t) => sanitizeIdentity(t), languages: ['rust'] },

  // Java
  { pattern: /^Runtime\.getRuntime(\(\))?\.exec$/, kind: 'SOCKET', extractIdentity: (t) => sanitizeIdentity(t), languages: ['java'] },
  { pattern: /^Files\.write$/, kind: 'FILE', extractIdentity: (t) => sanitizeIdentity(t), languages: ['java'] },
];

// ---------------------------------------------------------------------------
// Shared analysis state — used by both TS and multi-language paths
// ---------------------------------------------------------------------------

class TaintAnalysisState {
  readonly flows: TaintFlow[] = [];
  readonly variables = new Map<string, TaintSource>();
  readonly parameterTaint = new Map<string, TaintSource>();
  readonly interProceduralPaths = new Map<string, TaintPathNode[]>();
  readonly localFns = new Map<string, { node: ts.Node | LangSyntaxNode; params: string[] }>();
}

// ---------------------------------------------------------------------------
// Language adapter interface — abstracts language-specific operations
// ---------------------------------------------------------------------------

interface LanguageAdapter<N> {
  getQualifiedName(node: N): string;
  isCallNode(node: N): boolean;
  isFunctionNode(node: N): boolean;
  getFunctionName(node: N): string | undefined;
  getFunctionParams(node: N): string[];
  getCallArguments(node: N): N[];
  getArgumentText(node: N): string;
  extractIdentityFromInit(initNode: N, source: TaintSource): string;
  extractIdentityFromCall(callNode: N, source: TaintSource): string;
  getDeclarationInfo(node: N): { name: string; init: N } | null;
  getChildren(node: N): N[];
  chainRoot?(node: N): N;
}

// ---------------------------------------------------------------------------
// TypeScript adapter implementation
// ---------------------------------------------------------------------------

class TypeScriptAdapter implements LanguageAdapter<ts.Node> {
  constructor(private sourceFile: ts.SourceFile) {}

  getQualifiedName(node: ts.Node): string {
    if (ts.isIdentifier(node)) {
      return node.text;
    }
    if (ts.isPropertyAccessExpression(node)) {
      return `${this.getQualifiedName(node.expression)}.${node.name.text}`;
    }
    if (ts.isCallExpression(node)) {
      if (ts.isPropertyAccessExpression(node.expression)) {
        return this.getQualifiedName(node.expression);
      }
      if (ts.isIdentifier(node.expression)) {
        return node.expression.text;
      }
    }
    return node.getText(this.sourceFile);
  }

  isCallNode(node: ts.Node): boolean {
    return ts.isCallExpression(node);
  }

  isFunctionNode(node: ts.Node): boolean {
    return (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && !!node.name;
  }

  getFunctionName(node: ts.Node): string | undefined {
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
      return node.name?.getText(this.sourceFile);
    }
    return undefined;
  }

  getFunctionParams(node: ts.Node): string[] {
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
      return node.parameters.map((p) => (p.name && ts.isIdentifier(p.name) ? p.name.text : ''));
    }
    return [];
  }

  getCallArguments(node: ts.Node): ts.Node[] {
    if (ts.isCallExpression(node)) {
      return [...node.arguments];
    }
    return [];
  }

  getArgumentText(node: ts.Node): string {
    return node.getText(this.sourceFile);
  }

  extractIdentityFromInit(initNode: ts.Node, source: TaintSource): string {
    if (ts.isCallExpression(initNode) && initNode.arguments.length > 0) {
      return sanitizeIdentity(initNode.arguments[0]!.getText(this.sourceFile).replace(/[)'"]/g, ''));
    }
    if (ts.isPropertyAccessExpression(initNode)) {
      return sanitizeIdentity(initNode.name.text);
    }
    return sanitizeIdentity(source.identity);
  }

  extractIdentityFromCall(callNode: ts.Node, source: TaintSource): string {
    if (ts.isCallExpression(callNode) && callNode.arguments.length > 0) {
      return sanitizeIdentity(callNode.arguments[0]!.getText(this.sourceFile).replace(/[)'"]/g, ''));
    }
    return sanitizeIdentity(source.identity);
  }

  getDeclarationInfo(node: ts.Node): { name: string; init: ts.Node } | null {
    if (ts.isVariableDeclaration(node) && node.initializer && node.name && ts.isIdentifier(node.name)) {
      return { name: node.name.getText(this.sourceFile), init: node.initializer };
    }
    return null;
  }

  getChildren(node: ts.Node): ts.Node[] {
    const children: ts.Node[] = [];
    ts.forEachChild(node, (child) => children.push(child));
    return children;
  }
}

// ---------------------------------------------------------------------------
// Multi-language adapter implementation (tree-sitter)
// ---------------------------------------------------------------------------

class MultiLanguageAdapter implements LanguageAdapter<LangSyntaxNode> {
  constructor(
    private language: 'python' | 'go' | 'rust' | 'java',
  ) {}

  getQualifiedName(node: LangSyntaxNode): string {
    switch (this.language) {
      case 'python': {
        if (node.type === 'call') {
          const fn = node.childForFieldName('function');
          return fn ? this.getQualifiedName(fn) : node.text;
        }
        if (node.type === 'attribute') {
          const obj = node.childForFieldName('object');
          const attr = node.childForFieldName('attribute');
          return (obj ? this.getQualifiedName(obj) : '') + '.' + (attr?.text ?? '');
        }
        if (node.type === 'subscript') {
          const value = node.childForFieldName('value');
          return value ? this.getQualifiedName(value) : node.text;
        }
        return node.text;
      }
      case 'go': {
        if (node.type === 'call_expression') {
          const fn = node.childForFieldName('function');
          return fn ? this.getQualifiedName(fn) : node.text;
        }
        if (node.type === 'selector_expression') {
          const operand = node.childForFieldName('operand');
          const field = node.childForFieldName('field');
          return (operand ? this.getQualifiedName(operand) : '') + '.' + (field?.text ?? '');
        }
        return node.text;
      }
      case 'rust': {
        if (node.type === 'call_expression') {
          const fn = node.childForFieldName('function');
          return fn ? this.getQualifiedName(fn) : node.text;
        }
        if (node.type === 'field_expression') {
          const value = node.childForFieldName('value');
          const field = node.childForFieldName('field');
          return (value ? this.getQualifiedName(value) : '') + '.' + (field?.text ?? '');
        }
        if (node.type === 'scoped_identifier' || node.type === 'scoped_type_identifier') {
          const path = node.childForFieldName('path');
          const name = node.childForFieldName('name');
          return (path ? this.getQualifiedName(path) : '') + '::' + (name?.text ?? '');
        }
        return node.text;
      }
      case 'java': {
        if (node.type === 'method_invocation') {
          const name = node.childForFieldName('name');
          if (name) {
            const obj = node.childForFieldName('object');
            const objText = obj && obj.type !== 'this' && obj.type !== 'super' ? this.getQualifiedName(obj) : undefined;
            return (objText ? objText + '.' : '') + name.text;
          }
          return node.text;
        }
        if (node.type === 'field_access') {
          const obj = node.childForFieldName('object');
          const field = node.childForFieldName('field');
          return (obj ? this.getQualifiedName(obj) : '') + '.' + (field?.text ?? '');
        }
        return node.text;
      }
    }
  }

  isCallNode(node: LangSyntaxNode): boolean {
    return node.type === 'call' || node.type === 'call_expression' || node.type === 'method_invocation';
  }

  isFunctionNode(node: LangSyntaxNode): boolean {
    return ['function_definition', 'function_declaration', 'method_declaration', 'function_item'].includes(node.type);
  }

  getFunctionName(node: LangSyntaxNode): string | undefined {
    return node.childForFieldName('name')?.text;
  }

  getFunctionParams(node: LangSyntaxNode): string[] {
    const paramsNode = node.childForFieldName('parameters');
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
  }

  getCallArguments(node: LangSyntaxNode): LangSyntaxNode[] {
    const argsNode = node.childForFieldName('arguments');
    return argsNode ? [...argsNode.namedChildren] : [];
  }

  getArgumentText(node: LangSyntaxNode): string {
    return node.text.trim();
  }

  extractIdentityFromInit(initNode: LangSyntaxNode, source: TaintSource): string {
    if (this.isCallNode(initNode)) {
      return this.extractFromFirstArg(initNode) ?? sanitizeIdentity(source.identity);
    }
    if (initNode.type === 'subscript') {
      const idx = initNode.childForFieldName('subscript');
      return idx ? sanitizeIdentity(idx.text.replace(/^['"]|['"]$/g, '')) : sanitizeIdentity(source.identity);
    }
    if (initNode.type === 'attribute') {
      return sanitizeIdentity(initNode.childForFieldName('attribute')?.text ?? source.identity);
    }
    if (initNode.type === 'field_access') {
      return sanitizeIdentity(initNode.childForFieldName('field')?.text ?? source.identity);
    }
    return sanitizeIdentity(source.identity);
  }

  extractIdentityFromCall(callNode: LangSyntaxNode, source: TaintSource): string {
    return this.extractFromFirstArg(callNode) ?? sanitizeIdentity(source.identity);
  }

  getDeclarationInfo(node: LangSyntaxNode): { name: string; init: LangSyntaxNode } | null {
    switch (this.language) {
      case 'python': {
        if (node.type !== 'assignment') return null;
        const left = node.childForFieldName('left');
        const right = node.childForFieldName('right');
        if (!left || !right || left.type !== 'identifier') return null;
        return { name: left.text, init: right };
      }
      case 'go': {
        if (node.type !== 'short_var_declaration' && node.type !== 'assignment_statement') return null;
        const left = node.childForFieldName('left');
        const right = node.childForFieldName('right');
        if (!left || !right) return null;
        const single = left.type === 'expression_list' ? left.namedChildren[0] : left;
        if (!single || single.type !== 'identifier') return null;
        const initValue = right.type === 'expression_list' ? (right.namedChildren[0] ?? right) : right;
        return { name: single.text, init: initValue };
      }
      case 'rust': {
        if (node.type !== 'let_declaration') return null;
        const pattern = node.childForFieldName('pattern');
        const value = node.childForFieldName('value');
        if (!pattern || !value) return null;
        const ident =
          pattern.type === 'identifier'
            ? pattern
            : pattern.type === 'tuple_pattern' && pattern.namedChildren.length === 1 && pattern.namedChildren[0]?.type === 'identifier'
              ? pattern.namedChildren[0]!
              : undefined;
        if (!ident) return null;
        return { name: ident.text, init: value };
      }
      case 'java': {
        if (node.type === 'local_variable_declaration') {
          const declarator = node.childForFieldName('declarator');
          if (!declarator) return null;
          const name = declarator.childForFieldName('name');
          const value = declarator.childForFieldName('value');
          if (!name || !value) return null;
          return { name: name.text, init: value };
        }
        if (node.type === 'assignment_expression') {
          const left = node.childForFieldName('left');
          const right = node.childForFieldName('right');
          if (!left || !right || left.type !== 'identifier') return null;
          return { name: left.text, init: right };
        }
        return null;
      }
    }
  }

  getChildren(node: LangSyntaxNode): LangSyntaxNode[] {
    return [...node.namedChildren];
  }

  chainRoot(node: LangSyntaxNode): LangSyntaxNode {
    if (this.language !== 'python' && this.language !== 'rust') return node;
    let cur = node;
    while (true) {
      if (cur.type !== 'call' && cur.type !== 'call_expression') return cur;
      const fn = cur.childForFieldName('function');
      if (!fn) return cur;
      const inner =
        fn.type === 'attribute' ? fn.childForFieldName('object') :
        fn.type === 'field_expression' ? fn.childForFieldName('value') : undefined;
      if (!inner || (inner.type !== 'call' && inner.type !== 'call_expression')) return cur;
      cur = inner;
    }
  }

  private extractFromFirstArg(node: LangSyntaxNode): string | undefined {
    const argsNode = node.childForFieldName('arguments');
    const first = argsNode?.namedChildren[0];
    if (!first) return undefined;
    return sanitizeIdentity(first.text.replace(/^['"]|['"]$/g, ''));
  }
}

// ---------------------------------------------------------------------------
// Shared analysis logic — works with any LanguageAdapter
// ---------------------------------------------------------------------------

/**
 * Classify a source call expression to determine its resource kind and identity.
 * Returns undefined if the call is not a recognized source.
 */
function matchSource(text: string, language: StructuralLanguage): { kind: TaintSource['kind']; qualifiedName: string; identity: string } | undefined {
  for (const { pattern, kind, extractIdentity, languages } of SOURCE_PATTERNS) {
    if (languages && !languages.includes(language)) continue;
    const match = text.match(pattern);
    if (match) {
      return { kind, qualifiedName: match[0]!, identity: extractIdentity(text) };
    }
  }
  return undefined;
}

function matchSink(text: string, language: StructuralLanguage): { kind: TaintSink['kind']; identity: string } | null {
  for (const { pattern, kind, extractIdentity, languages } of SINK_PATTERNS) {
    if (languages && !languages.includes(language)) continue;
    if (pattern.test(text)) {
      return { kind, identity: extractIdentity(text) };
    }
  }
  return null;
}

// Type alias for the node types we work with
type AnalysisNode = ts.Node | LangSyntaxNode;

/**
 * Create a visit function for the given adapter and state.
 * This is the shared logic that was previously duplicated between
 * analyzeTypeScript and analyzeMultiLanguage.
 */
function createVisitor<N extends AnalysisNode>(
  adapter: LanguageAdapter<N>,
  state: TaintAnalysisState,
  language: StructuralLanguage,
): (node: N, currentFunctionName: string | undefined, path?: TaintPathNode[]) => void {
  const visit = (node: N, currentFunctionName: string | undefined, path: TaintPathNode[] = []): void => {
    const currentPath = [...path];

    // Variable declarations initialize taint.
    const decl = adapter.getDeclarationInfo(node);
    if (decl) {
      const initNode = adapter.chainRoot ? adapter.chainRoot(decl.init) : decl.init;
      const calleeText = sanitizeIdentity(adapter.getQualifiedName(initNode));
      const source = matchSource(calleeText, language);
      if (source) {
        const src: TaintSource = { ...source, node: decl.init as AnalysisNode };
        const identity = adapter.extractIdentityFromInit(initNode, src);
        state.variables.set(decl.name, { ...src, identity });
        currentPath.push({ node: decl.init as AnalysisNode, type: 'source' as const, function: currentFunctionName, variable: decl.name });
      }
    }

    if (adapter.isCallNode(node)) {
      const nodeForChain = adapter.chainRoot ? adapter.chainRoot(node) : node;
      const calleeText = sanitizeIdentity(adapter.getQualifiedName(nodeForChain));
      const bareName: string | undefined =
        calleeText && !calleeText.includes('.') && !calleeText.includes('(') && !calleeText.includes(':') ? calleeText : undefined;

      // Source call site: a tainted variable passed INTO a known source API.
      const source = matchSource(calleeText, language);
      if (source) {
        const sourceWithNode: TaintSource = { ...source, node: node as AnalysisNode };
        const identity = adapter.extractIdentityFromCall(node, sourceWithNode);
        for (const arg of adapter.getCallArguments(node)) {
          const argText = adapter.getArgumentText(arg);
          const varSource = state.variables.get(argText);
          if (varSource) {
            state.flows.push({
              source: { ...varSource, identity },
              sink: { qualifiedName: calleeText, kind: source.kind, identity: calleeText, node: node as AnalysisNode },
              viaFunction: currentFunctionName,
              viaVariable: argText,
              path: [
                ...currentPath,
                { node: varSource.node, type: 'source' as const, function: currentFunctionName, variable: argText },
                { node: node as AnalysisNode, type: 'intermediate' as const, function: currentFunctionName },
              ],
            });
          }
        }
      }

      // Inter-procedural seed: tainted argument flowing into a LOCAL function.
      if (bareName) {
        const fn = state.localFns.get(bareName);
        if (fn) {
          adapter.getCallArguments(node).forEach((argNode, idx) => {
            const argText = adapter.getArgumentText(argNode);
            const varSource = state.variables.get(argText);
            const paramName = fn.params[idx];
            if (varSource && paramName && !state.parameterTaint.has(`${bareName}.${paramName}`)) {
              state.parameterTaint.set(`${bareName}.${paramName}`, varSource);
              state.interProceduralPaths.set(`${bareName}.${paramName}`, [
                ...currentPath,
                { node: varSource.node, type: 'source' as const, function: currentFunctionName, variable: argText },
                { node: argNode as AnalysisNode, type: 'intermediate' as const, function: currentFunctionName },
              ]);
            }
          });
        }
      }

      // Sink call site.
      const sinkInfo = matchSink(calleeText, language);
      if (sinkInfo) {
        for (const arg of adapter.getCallArguments(node)) {
          const argText = adapter.getArgumentText(arg);
          const varSource = state.variables.get(argText);
          if (varSource) {
            state.flows.push({
              source: varSource,
              sink: { qualifiedName: calleeText, kind: sinkInfo.kind, identity: sanitizeIdentity(sinkInfo.identity), node: node as AnalysisNode },
              viaFunction: currentFunctionName,
              viaVariable: argText,
              path: [
                ...currentPath,
                { node: varSource.node, type: 'source' as const, function: currentFunctionName, variable: argText },
                { node: node as AnalysisNode, type: 'sink' as const, function: currentFunctionName },
              ],
            });
          }
        }
      }
    }

    const fnName = adapter.isFunctionNode(node) ? adapter.getFunctionName(node) : undefined;
    for (const child of adapter.getChildren(node)) {
      visit(child, fnName ?? currentFunctionName, currentPath);
    }
  };

  return visit;
}

/**
 * Collect local functions before the main pass so call sites can seed them.
 */
function collectLocalFunctions<N extends AnalysisNode>(
  root: N,
  adapter: LanguageAdapter<N>,
  state: TaintAnalysisState,
): void {
  const collect = (node: N): void => {
    if (adapter.isFunctionNode(node)) {
      const name = adapter.getFunctionName(node);
      if (name) state.localFns.set(name, { node: node as AnalysisNode, params: adapter.getFunctionParams(node) });
    }
    for (const child of adapter.getChildren(node)) collect(child);
  };
  collect(root);
}

/**
 * Run the inter-procedural pass with path tracking.
 * This is the shared logic that was previously duplicated between
 * analyzeTypeScript and analyzeMultiLanguage.
 */
function runInterProceduralPass<N extends AnalysisNode>(
  visit: (node: N, currentFunctionName: string | undefined, path?: TaintPathNode[]) => void,
  adapter: LanguageAdapter<N>,
  state: TaintAnalysisState,
): void {
  for (const [fnName, fn] of state.localFns) {
    const seeds = fn.params
      .map((p) => ({ p, src: state.parameterTaint.get(`${fnName}.${p}`), path: state.interProceduralPaths.get(`${fnName}.${p}`) }))
      .filter((s): s is { p: string; src: TaintSource; path: TaintPathNode[] } => !!s.src && !!s.path);

    if (seeds.length === 0) continue;

    for (const s of seeds) {
      state.variables.set(s.p, s.src);
      state.interProceduralPaths.set(`local.${s.p}`, s.path);
    }

    const before = state.flows.length;
    for (const child of adapter.getChildren(fn.node as N)) {
      visit(child, fnName);
    }

    for (let i = before; i < state.flows.length; i++) {
      const seed = seeds.find(s => s.p === state.flows[i].viaVariable);
      if (seed) {
        state.flows[i] = {
          ...state.flows[i],
          viaFunction: `${fnName} → ${state.flows[i].viaFunction ?? '(body)'}`,
          path: [...seed.path, ...state.flows[i].path.slice(1)],
        };
      }
    }

    // Unseed to keep subsequent functions independent.
    for (const s of seeds) state.variables.delete(s.p);
  }
}

// ---------------------------------------------------------------------------
// TaintAnalyzer class — orchestrates analysis using shared infrastructure
// ---------------------------------------------------------------------------

export class TaintAnalyzer {
  private static readonly SUPPORTED: readonly StructuralLanguage[] = ['typescript', 'javascript', 'python', 'go', 'rust', 'java'];

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
  // TypeScript/JavaScript path (TypeScript Compiler API)
  // ---------------------------------------------------------------------------

  private analyzeTypeScript(filePath: string, content: string, language: 'typescript' | 'javascript'): TaintFlow[] {
    const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
    const adapter = new TypeScriptAdapter(sourceFile);
    const state = new TaintAnalysisState();

    // Collect local functions BEFORE the main pass so call sites can seed them.
    collectLocalFunctions(sourceFile, adapter, state);

    // Create the shared visitor function.
    const visit = createVisitor(adapter, state, language);

    // Run main pass over top-level statements, tracking function context.
    for (const statement of sourceFile.statements) {
      const fnName = adapter.isFunctionNode(statement) ? adapter.getFunctionName(statement) : undefined;
      visit(statement, fnName);
    }

    // Inter-procedural pass with path tracking.
    runInterProceduralPass(visit, adapter, state);

    return state.flows;
  }

  // ---------------------------------------------------------------------------
  // Python / Go / Rust / Java path (tree-sitter)
  // ---------------------------------------------------------------------------

  private analyzeMultiLanguage(filePath: string, content: string, language: 'python' | 'go' | 'rust' | 'java'): TaintFlow[] {
    const parsed = createLangParser(filePath, content);
    if (!parsed) return [];
    const root = parsed.root;
    const adapter = new MultiLanguageAdapter(language);
    const state = new TaintAnalysisState();

    // Collect local functions BEFORE the main pass so call sites can seed them.
    collectLocalFunctions(root, adapter, state);

    // Create the shared visitor function.
    const visit = createVisitor(adapter, state, language);

    // Run main pass.
    visit(root, undefined);

    // Inter-procedural pass with path tracking.
    runInterProceduralPass(visit, adapter, state);

    return state.flows;
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
