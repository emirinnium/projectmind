import { getParserDefinition, type ParserLanguage } from './parser-registry.js';

/**
 * Languages supported by the structural analysis layer.
 * TypeScript and JavaScript share the TypeScript Compiler API, which gives both
 * languages one precise AST implementation and keeps the package lightweight.
 */
export type StructuralLanguage = 'typescript' | 'javascript';

/**
 * Detect the structural language of a file from its extension.
 * Returns null for unsupported extensions.
 */
export function detectLanguageFromPath(filePath: string): StructuralLanguage | null {
  const entry = getParserDefinition(filePath);
  return entry && isStructuralLanguage(entry.language) ? entry.language : null;
}

function isStructuralLanguage(language: ParserLanguage): language is StructuralLanguage {
  return language === 'typescript' || language === 'javascript';
}
