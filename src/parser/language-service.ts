import { readFileSync } from 'node:fs';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import Python from 'tree-sitter-python';
import Go from 'tree-sitter-go';
import Rust from 'tree-sitter-rust';
import Java from 'tree-sitter-java';
import { logger } from '../utils/logger.js';

/**
 * Structural languages supported by ProjectMind's parser layer.
 *
 * TypeScript/JavaScript use the TypeScript Compiler API for precision; all
 * other languages go through tree-sitter grammars. This is the shared contract
 * used by taint analysis and structural search.
 */
export type StructuralLanguage = 'typescript' | 'javascript' | 'python' | 'go' | 'rust' | 'java';

/**
 * Minimal structural interface for tree-sitter syntax nodes.
 *
 * Consumers (taint analysis, structural search) only rely on these members,
 * which keeps them decoupled from tree-sitter's concrete types and makes the
 * multi-language layer swappable.
 */
export interface LangSyntaxNode {
  readonly type: string;
  readonly text: string;
  readonly startPosition: { row: number; column: number };
  readonly endPosition: { row: number; column: number };
  readonly startIndex: number;
  readonly endIndex: number;
  readonly isNamed: boolean;
  readonly children: readonly LangSyntaxNode[];
  readonly namedChildren: readonly LangSyntaxNode[];
  childForFieldName(fieldName: string): LangSyntaxNode | null;
}

const LANGUAGE_MAP: Record<string, { grammar: Parser.Language; language: StructuralLanguage }> = {
  '.ts': { grammar: TypeScript.typescript, language: 'typescript' },
  '.tsx': { grammar: TypeScript.tsx, language: 'typescript' },
  '.js': { grammar: TypeScript.typescript, language: 'javascript' },
  '.jsx': { grammar: TypeScript.tsx, language: 'javascript' },
  '.mjs': { grammar: TypeScript.typescript, language: 'javascript' },
  '.cjs': { grammar: TypeScript.typescript, language: 'javascript' },
  '.py': { grammar: Python, language: 'python' },
  '.go': { grammar: Go, language: 'go' },
  '.rs': { grammar: Rust, language: 'rust' },
  '.java': { grammar: Java, language: 'java' },
};

/**
 * Detect the structural language of a file from its extension.
 * Returns null for unsupported extensions.
 */
export function detectLanguageFromPath(filePath: string): StructuralLanguage | null {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  const entry = LANGUAGE_MAP[ext];
  return entry ? entry.language : null;
}

/**
 * Parser pool — one tree-sitter Parser per grammar, reused across every
 * `createLangParser` call.
 *
 * Constructing a Parser + `setLanguage` loads/copies the grammar into the
 * parser; doing it per file creates needless churn (allocation + grammar
 * wiring) on every scan of a multi-language project. tree-sitter parsers are
 * synchronous single-threaded objects, so pooling is safe: `parse()` is
 * re-entrant, each call returns a fresh independent Tree.
 */
const PARSER_POOL = new Map<Parser.Language, Parser>();

function getParserFor(grammar: Parser.Language): Parser {
  let parser = PARSER_POOL.get(grammar);
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(grammar);
    PARSER_POOL.set(grammar, parser);
  }
  return parser;
}

/**
 * Create a tree-sitter parser for the given file path (or explicit content).
 *
 * Returns null when the extension is unsupported or parsing fails — callers
 * treat unparseable files as "no results" rather than errors.
 */
export function createLangParser(filePath: string, content?: string): { language: StructuralLanguage; root: LangSyntaxNode } | null {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  const entry = LANGUAGE_MAP[ext];
  if (!entry) return null;

  let sourceText: string;
  try {
    sourceText = content ?? readFileSync(filePath, 'utf-8');
  } catch {
    logger.debug(`Failed to read file for parsing: ${filePath}`);
    return null;
  }

  const parser = getParserFor(entry.grammar);

  let tree: Parser.Tree;
  try {
    tree = parser.parse(sourceText);
    if (!tree) return null;
  } catch {
    logger.debug(`Failed to parse file: ${filePath}`);
    return null;
  }

  return { language: entry.language, root: tree.rootNode as LangSyntaxNode };
}