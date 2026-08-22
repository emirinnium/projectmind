import { readFileSync } from 'node:fs';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import Python from 'tree-sitter-python';
import Go from 'tree-sitter-go';
import Rust from 'tree-sitter-rust';
import Java from 'tree-sitter-java';
import CSharp from 'tree-sitter-c-sharp';
import CPP from 'tree-sitter-cpp';
import Ruby from 'tree-sitter-ruby';
import { logger } from '../utils/logger.js';
import type { Language, FileStructure, FunctionInfo, ClassInfo } from './types.js';

const LANGUAGE_MAP: Record<string, { language: Parser.Language; name: Language }> = {
  '.ts': { language: TypeScript.typescript, name: 'typescript' },
  '.tsx': { language: TypeScript.tsx, name: 'typescript' },
  '.js': { language: TypeScript.typescript, name: 'javascript' },
  '.jsx': { language: TypeScript.tsx, name: 'javascript' },
  '.mjs': { language: TypeScript.typescript, name: 'javascript' },
  '.cjs': { language: TypeScript.typescript, name: 'javascript' },
  '.py': { language: Python, name: 'python' },
  '.go': { language: Go, name: 'go' },
  '.rs': { language: Rust, name: 'rust' },
  '.java': { language: Java, name: 'java' },
  '.cs': { language: CSharp, name: 'csharp' },
  '.csx': { language: CSharp, name: 'csharp' },
  '.c': { language: CPP, name: 'cpp' }, // tree-sitter-cpp grammar covers plain C
  '.cpp': { language: CPP, name: 'cpp' },
  '.cc': { language: CPP, name: 'cpp' },
  '.cxx': { language: CPP, name: 'cpp' },
  '.hpp': { language: CPP, name: 'cpp' },
  '.h': { language: CPP, name: 'cpp' },
  '.rb': { language: Ruby, name: 'ruby' },
  '.rake': { language: Ruby, name: 'ruby' },
  '.gemspec': { language: Ruby, name: 'ruby' },
};

export function parseFileMultilang(filePath: string, content?: string): FileStructure | null {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  const entry = LANGUAGE_MAP[ext];

  if (!entry) {
    return null;
  }

  let sourceText: string;
  try {
    sourceText = content ?? readFileSync(filePath, 'utf-8');
  } catch {
    logger.warn(`Failed to read file: ${filePath}`);
    return null;
  }

  const parser = new Parser();
  parser.setLanguage(entry.language);

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

  const lines = sourceText.split('\n');

  const visit = (node: Parser.SyntaxNode): void => {
    const nodeType = node.type;
    const lang = entry.name;

    // Functions - different node types per language
    const functionTypes: Record<string, string[]> = {
      typescript: ['function_declaration', 'method_definition', 'arrow_function', 'function_expression'],
      javascript: ['function_declaration', 'method_definition', 'arrow_function', 'function_expression'],
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
      const paramsNode = node.childForFieldName('parameters') || node.childForFieldName('parameters_node');
      const params = paramsNode?.text ?? '()';

      functions.push({
        name,
        signature: `${name}${params}`,
        returnType: 'any',
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        complexity: 0,
        kind: nodeType === 'method_definition' || nodeType === 'method_declaration' || nodeType === 'method' ? 'method' : 'function',
        parameters: [],
        isExported: false,
        isAsync: false,
        cyclomaticComplexity: 1,
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
    language: entry.name,
    sizeBytes: sourceText.length,
    functions,
    classes,
    imports,
    exports,
    hash: '',
    lines: lines.length,
  };
}
