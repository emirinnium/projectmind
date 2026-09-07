export type ParserLanguage = 'typescript' | 'javascript';

export interface ParserDefinition {
  readonly extensions: readonly string[];
  readonly language: ParserLanguage;
  readonly capabilities: ReadonlySet<'functions' | 'classes' | 'imports' | 'exports'>;
}

const fullCapabilities = new Set<
  ParserDefinition['capabilities'] extends ReadonlySet<infer T> ? T : never
>(['functions', 'classes', 'imports', 'exports']);

export const PARSER_DEFINITIONS: readonly ParserDefinition[] = [
  {
    extensions: ['.ts'],
    language: 'typescript',
    capabilities: fullCapabilities,
  },
  {
    extensions: ['.tsx'],
    language: 'typescript',
    capabilities: fullCapabilities,
  },
  {
    extensions: ['.js', '.mjs', '.cjs'],
    language: 'javascript',
    capabilities: fullCapabilities,
  },
  {
    extensions: ['.jsx'],
    language: 'javascript',
    capabilities: fullCapabilities,
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
