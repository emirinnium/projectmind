import { extname } from 'node:path';
import { parseTypeScriptFile } from './ast/parser.js';
import { parseFileMultilang } from './multilang-parser.js';

export type Language = 'typescript' | 'javascript' | 'python' | 'go' | 'rust' | 'java' | 'csharp' | 'cpp' | 'ruby' | 'unknown';

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

export interface ClassInfo {
  name: string;
  signature: string;
  startLine: number;
  endLine: number;
  methodsCount: number;
  propertiesCount: number;
  extends: string | null;
  implements: string[];
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

export function detectLanguage(filePath: string): Language {
  const ext = extname(filePath);
  switch (ext) {
    case '.ts':
    case '.tsx':
      return 'typescript';
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return 'javascript';
    case '.py':
      return 'python';
    case '.go':
      return 'go';
    case '.rs':
      return 'rust';
    case '.java':
      return 'java';
    case '.cs':
    case '.csx':
      return 'csharp';
    case '.cpp':
    case '.cc':
    case '.cxx':
    case '.hpp':
    case '.h':
      return 'cpp';
    case '.rb':
    case '.rake':
      return 'ruby';
    default:
      return 'unknown';
  }
}

export function parseFile(filePath: string, content?: string): FileStructure | null {
  const lang = detectLanguage(filePath);
  if (lang === 'typescript' || lang === 'javascript') {
    return parseTypeScriptFile(filePath, content, lang);
  }
  // Use multi-language parser for Python, Go, Rust
  return parseFileMultilang(filePath, content);
}

// Re-export the implementation
export { parseTypeScriptFile } from './ast/parser.js';
export { parseFileMultilang } from './multilang-parser.js';