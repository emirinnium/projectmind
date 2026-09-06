import { readFileSync } from 'node:fs';
import Parser from 'tree-sitter';
import { logger } from '../utils/logger.js';
import { getParserFor } from './language-service.js';
import { getParserDefinition } from './parser-registry.js';
import type { Language, FileStructure, FunctionInfo, ClassInfo } from './types.js';
import { assertSourceSize, assertSourceTextSize } from './source-limits.js';

export function parseFileMultilang(filePath: string, content?: string): FileStructure | null {
  const definition = getParserDefinition(filePath);

  if (!definition) {
    return null;
  }

  let sourceText: string;
  try {
    if (content === undefined) assertSourceSize(filePath);
    sourceText = content ?? readFileSync(filePath, 'utf-8');
    assertSourceTextSize(filePath, sourceText);
  } catch {
    logger.warn(`Failed to read file: ${filePath}`);
    return null;
  }

  // K12/R14: reuse the pooled parser per grammar instead of allocating a new
  // Parser per file (each carries an expensive native grammar — pooling fixed
  // the RSS leak for language-service and applies to this hot path too).
  const parser = getParserFor(definition.grammar);

  let tree: Parser.Tree;
  try {
    tree = parser.parse(sourceText);
    if (!tree) {
      logger.warn(`Parser returned null for file: ${filePath}`);
      return null;
    }
  } catch {
    logger.warn(`Failed to parse file: ${filePath}`);
    return null;
  }
  const functions: FunctionInfo[] = [];
  const classes: ClassInfo[] = [];
  const imports: { source: string; named: string[]; kind: string }[] = [];
  const exports: string[] = [];

  const lines = sourceText.split(/\r?\n/);

  const visit = (node: Parser.SyntaxNode): void => {
    const nodeType = node.type;
    const lang = definition.language;

    // Functions - different node types per language
    const functionTypes: Record<string, string[]> = {
      typescript: [
        'function_declaration',
        'method_definition',
        'arrow_function',
        'function_expression',
      ],
      javascript: [
        'function_declaration',
        'method_definition',
        'arrow_function',
        'function_expression',
      ],
      python: ['function_definition'],
      go: ['function_declaration', 'method_declaration'],
      rust: ['function_item', 'closure_expression'],
      java: ['method_declaration', 'constructor_declaration'],
      csharp: ['method_declaration', 'constructor_declaration', 'local_function_statement'],
      cpp: ['function_definition', 'function_declarator'],
      ruby: ['method', 'singleton_method'],
    };

    if (functionTypes[lang]?.includes(nodeType)) {
      const nameNode = node.childForFieldName('name');
      const name = nameNode?.text ?? 'anonymous';
      const paramsNode =
        node.childForFieldName('parameters') || node.childForFieldName('parameters_node');
      const params = paramsNode?.text ?? '()';

      // Return type when the grammar exposes one (TS/Python/Rust/Java/Go);
      // honest 'any' fallback otherwise.
      const typeNode =
        node.childForFieldName('type') ??
        node.childForFieldName('return_type') ??
        node.childForFieldName('result');

      // Real cyclomatic complexity: 1 + decision points inside the function.
      const complexity =
        1 +
        node.descendantsOfType([
          'if_statement',
          'if_expression',
          'elif_clause',
          'else_clause',
          'switch_statement',
          'switch_case',
          'case_statement',
          'match_arm',
          'for_statement',
          'for_in_statement',
          'for_each_statement',
          'while_statement',
          'do_statement',
          'do_while_statement',
          'catch_clause',
          'except_clause',
          'handler',
          'conditional_expression',
          'ternary_expression',
        ]).length;

      functions.push({
        name,
        signature: `${name}${params}`,
        returnType: typeNode?.text ?? 'unknown',
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        complexity,
        kind:
          nodeType === 'method_definition' ||
          nodeType === 'method_declaration' ||
          nodeType === 'method'
            ? 'method'
            : 'function',
        parameters: [],
        isExported: false,
        isAsync: false,
        cyclomaticComplexity: complexity,
      });
    }

    // Classes/Structs
    const classTypes: Record<string, string[]> = {
      typescript: ['class_declaration'],
      javascript: ['class_declaration'],
      python: ['class_definition'],
      go: ['type_spec', 'struct_type'],
      rust: ['struct_item', 'impl_item', 'trait_item'],
      java: ['class_declaration', 'interface_declaration'],
      csharp: ['class_declaration', 'struct_declaration', 'interface_declaration'],
      cpp: ['class_specifier', 'struct_specifier'],
      ruby: ['class', 'module', 'singleton_class'],
    };

    if (classTypes[lang]?.includes(nodeType)) {
      const nameNode = node.childForFieldName('name');
      const name = nameNode?.text ?? 'Anonymous';

      classes.push({
        name,
        signature: name,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        methodsCount: 0,
        propertiesCount: 0,
        extends: null,
        implements: [],
        methods: [],
        properties: [],
        cognitiveLoad: 0,
      });
    }

    // Imports
    const importTypes: Record<string, string[]> = {
      typescript: ['import_statement'],
      javascript: ['import_statement'],
      python: ['import_statement', 'import_from_statement'],
      go: ['import_spec', 'import_declaration'],
      rust: ['use_declaration'],
      java: ['import_declaration'],
      csharp: ['using_directive'],
      cpp: ['preproc_include', 'using_declaration'],
      ruby: ['require', 'require_relative', 'load', 'include', 'extend'],
    };

    if (importTypes[lang]?.includes(nodeType)) {
      const source = node.childForFieldName('source')?.text ?? node.text;
      imports.push({ source, named: [], kind: 'import' });
    }

    // Recurse
    for (const child of node.children) {
      visit(child);
    }
  };

  visit(tree.rootNode);

  return {
    filePath,
    language: definition.language as Language,
    sizeBytes: sourceText.length,
    functions,
    classes,
    imports,
    exports,
    hash: '',
    lines: lines.length,
  };
}
