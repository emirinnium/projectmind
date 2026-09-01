/**
 * Shared parser type contracts.
 *
 * Extracted from ast-parser.ts to break two real circular dependencies:
 *   ast-parser -> ast/parser -> ast-parser
 *   ast-parser -> multilang-parser -> ast-parser
 * Both parser implementations now import these types from here; ast-parser
 * re-exports them for backwards compatibility.
 */

export type Language =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'go'
  | 'rust'
  | 'java'
  | 'csharp'
  | 'cpp'
  | 'ruby'
  | 'unknown';

export interface ParameterInfo {
  name: string;
  type: string;
}

export interface FunctionInfo {
  name: string;
  signature: string;
  returnType: string;
  startLine: number;
  endLine: number;
  complexity: number;
  kind: 'function' | 'method' | 'arrow' | 'function-expression';
  parameters: ParameterInfo[];
  isExported: boolean;
  isAsync: boolean;
  cyclomaticComplexity: number;
}

export interface ClassMemberInfo {
  name: string;
  kind: 'method' | 'property' | 'constructor';
  isStatic: boolean;
  accessModifier: 'public' | 'private' | 'protected' | undefined;
}

export interface ClassInfo {
  name: string;
  signature: string;
  startLine: number;
  endLine: number;
  methodsCount: number;
  propertiesCount: number;
  extends: string | null;
  implements: string[];
  /** Detailed member list (populated when AST parser provides it). */
  methods: ClassMemberInfo[];
  properties: ClassMemberInfo[];
  /** Approximate cognitive load heuristic for the class body. */
  cognitiveLoad: number;
}

export interface FileStructure {
  filePath: string;
  language: Language;
  sizeBytes: number;
  functions: FunctionInfo[];
  classes: ClassInfo[];
  imports: { source: string; named: string[]; kind: string }[];
  exports: string[];
  hash: string;
  lines: number;
}
