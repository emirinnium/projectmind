import { extname } from 'node:path';
import { parseTypeScriptFile } from './ast/parser.js';
import { parseFileMultilang } from './multilang-parser.js';
import type { FileStructure, Language } from './types.js';

// Types live in ./types.ts (breaks the ast-parser <-> ast/parser and
// ast-parser <-> multilang-parser import cycles); re-exported here for
// backwards compatibility with existing consumers.
export type {
  Language,
  ParameterInfo,
  FunctionInfo,
  ClassInfo,
  FileStructure,
} from './types.js';

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