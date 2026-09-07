import { extname } from 'node:path';
import { parseTypeScriptFile } from './ast/parser.js';
import type { FileStructure, Language } from './types.js';

// Types live in ./types.ts to break the ast-parser <-> ast/parser cycle.
export type { Language, ParameterInfo, FunctionInfo, ClassInfo, FileStructure } from './types.js';

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
    default:
      return 'unknown';
  }
}

export function parseFile(filePath: string, content?: string): FileStructure | null {
  const lang = detectLanguage(filePath);
  if (lang === 'typescript' || lang === 'javascript') {
    return parseTypeScriptFile(filePath, content, lang);
  }
  return null;
}

// Re-export the TypeScript/JavaScript implementation.
export { parseTypeScriptFile } from './ast/parser.js';
