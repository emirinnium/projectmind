import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import Python from 'tree-sitter-python';
import Go from 'tree-sitter-go';
import Rust from 'tree-sitter-rust';
import Java from 'tree-sitter-java';
import CSharp from 'tree-sitter-c-sharp';
import CPP from 'tree-sitter-cpp';
import Ruby from 'tree-sitter-ruby';

export type ParserLanguage =
  'typescript' | 'javascript' | 'python' | 'go' | 'rust' | 'java' | 'csharp' | 'cpp' | 'ruby';

export interface ParserDefinition {
  readonly extensions: readonly string[];
  readonly grammar: Parser.Language;
  readonly language: ParserLanguage;
  readonly capabilities: ReadonlySet<'functions' | 'classes' | 'imports' | 'exports'>;
}

const fullCapabilities = new Set<
  ParserDefinition['capabilities'] extends ReadonlySet<infer T> ? T : never
>(['functions', 'classes', 'imports', 'exports']);

export const PARSER_DEFINITIONS: readonly ParserDefinition[] = [
  {
    extensions: ['.ts'],
    grammar: TypeScript.typescript,
    language: 'typescript',
    capabilities: fullCapabilities,
  },
  {
    extensions: ['.tsx'],
    grammar: TypeScript.tsx,
    language: 'typescript',
    capabilities: fullCapabilities,
  },
  {
    extensions: ['.js', '.mjs', '.cjs'],
    grammar: TypeScript.typescript,
    language: 'javascript',
    capabilities: fullCapabilities,
  },
  {
    extensions: ['.jsx'],
    grammar: TypeScript.tsx,
    language: 'javascript',
    capabilities: fullCapabilities,
  },
  {
    extensions: ['.py'],
    grammar: Python,
    language: 'python',
    capabilities: new Set(['functions', 'classes', 'imports']),
  },
  {
    extensions: ['.go'],
    grammar: Go,
    language: 'go',
    capabilities: new Set(['functions', 'classes', 'imports']),
  },
  {
    extensions: ['.rs'],
    grammar: Rust,
    language: 'rust',
    capabilities: new Set(['functions', 'classes', 'imports']),
  },
  {
    extensions: ['.java'],
    grammar: Java,
    language: 'java',
    capabilities: new Set(['functions', 'classes', 'imports']),
  },
  {
    extensions: ['.cs', '.csx'],
    grammar: CSharp,
    language: 'csharp',
    capabilities: new Set(['functions', 'classes', 'imports']),
  },
  {
    extensions: ['.c', '.cpp', '.cc', '.cxx', '.hpp', '.h'],
    grammar: CPP,
    language: 'cpp',
    capabilities: new Set(['functions', 'classes', 'imports']),
  },
  {
    extensions: ['.rb', '.rake', '.gemspec'],
    grammar: Ruby,
    language: 'ruby',
    capabilities: new Set(['functions', 'classes', 'imports']),
  },
];

const BY_EXTENSION = new Map<string, ParserDefinition>();
for (const definition of PARSER_DEFINITIONS) {
  for (const extension of definition.extensions) BY_EXTENSION.set(extension, definition);
}

export function getParserDefinition(filePath: string): ParserDefinition | null {
  const dot = filePath.lastIndexOf('.');
  if (dot < 0) return null;
  return BY_EXTENSION.get(filePath.slice(dot).toLowerCase()) ?? null;
}

export function listParserCapabilities(): Array<{
  language: ParserLanguage;
  extensions: string[];
  capabilities: string[];
}> {
  return PARSER_DEFINITIONS.map((definition) => ({
    language: definition.language,
    extensions: [...definition.extensions],
    capabilities: [...definition.capabilities],
  }));
}
