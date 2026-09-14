import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { CoherenceCache } from '../../cache/index.js';
import { FileInfo } from '../../../storage/knowledge-graph.js';
import { ContractEngine } from '../../contracts/engine.js';
import { stableHash } from '../../../utils/hash.js';
import { calculateCyclomaticComplexity } from '../../../parser/ast/parser.js';

// Thresholds for fast-tier coherence analysis
const MAX_FILE_LINES = 400;
const MAX_IMPORT_COUNT = 20;
const MAX_ANY_USAGE = 5;
const MAX_CONSOLE_COUNT = 3;
const MAX_DECISION_POINTS = 10;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface LLMProvider {
  name: string;
  model: string;
  isAvailable(): boolean;
  analyze(prompt: string, systemPrompt?: string, temperature?: number): Promise<LLMResponse>;
}

export interface LLMResponse {
  content: string;
  reasoningTrace: string[];
  confidence: number;
  usage?: { inputTokens: number; outputTokens: number };
  responseTimeMs: number;
  responseMode?: 'content' | 'reasoning-only' | 'empty';
  finishReason?: string;
}

export interface CoherenceResult {
  verdict: 'pass' | 'warn' | 'fail';
  confidence: number;
  reasoningTrace: string[];
  suggestions: string[];
  llmProvider: string;
  responseTimeMs: number;
  responseMode?: 'content' | 'reasoning-only' | 'empty';
  finishReason?: string;
}

export interface CoherenceCheckOptions {
  code: string;
  filePath: string;
  contextFiles?: FileInfo[];
  deepAnalysis?: boolean;
  fastOnly?: boolean;
}

/**
 * Handles fast-tier coherence analysis
 */
export class FastCoherenceAnalyzer {
  private cache: CoherenceCache;
  private db: DatabaseSync;
  private contractEngine: ContractEngine;

  constructor(db: DatabaseSync, cache: CoherenceCache, contractEngine?: ContractEngine) {
    this.db = db;
    this.cache = cache;
    this.contractEngine = contractEngine || new ContractEngine();
  }

  analyze(options: CoherenceCheckOptions, cacheKey: string): CoherenceResult {
    const startTime = Date.now();
    const reasoningTrace: string[] = [];

    reasoningTrace.push('Fast-tier analysis started');
    reasoningTrace.push(`File: ${options.filePath}`);
    reasoningTrace.push(`Code length: ${options.code.length} characters`);

    const lines = options.code.split(/\r?\n/);
    reasoningTrace.push(`Line count: ${lines.length}`);

    let issues = 0;
    const suggestions: string[] = [];

    // Semantic Analysis
    const semanticIssues = this.semanticAnalysis(options.code, options.filePath);
    issues += semanticIssues.issues;
    reasoningTrace.push(...semanticIssues.reasoningTrace);
    suggestions.push(...semanticIssues.suggestions);

    if (lines.length > MAX_FILE_LINES) {
      reasoningTrace.push(
        `Warning: File exceeds ${MAX_FILE_LINES} lines (${lines.length}) — cognitive load concern`,
      );
      suggestions.push('Consider splitting this file into smaller modules');
      issues++;
    }

    const importCount = (options.code.match(/^\s*import\s+/gm) || []).length;
    if (importCount > MAX_IMPORT_COUNT) {
      reasoningTrace.push(`Warning: High import count (${importCount}) — potential coupling issue`);
      suggestions.push('Review imports for unnecessary dependencies');
      issues++;
    }

    // Count actual TypeScript AnyKeyword nodes instead of matching text. A
    // regex also counts comments, documentation and string literals, which
    // turned harmless files into false-positive debt findings.
    const anyUsage = countExplicitAnyTypes(options.code, options.filePath);
    if (anyUsage > MAX_ANY_USAGE) {
      reasoningTrace.push(
        `Warning: Found ${anyUsage} explicit "any" type annotations — type safety concern`,
      );
      suggestions.push('Replace "any" with specific types or unknown');
      issues++;
    }

    const consoleCount = (options.code.match(/console\.\w+/g) || []).length;
    const isExcludedPath =
      options.filePath.includes('/cli/commands/') ||
      options.filePath.includes('\\cli\\commands\\') ||
      options.filePath.includes('/scripts/') ||
      options.filePath.includes('\\scripts\\') ||
      options.filePath.includes('/tests/') ||
      options.filePath.includes('\\tests\\');
    if (consoleCount > MAX_CONSOLE_COUNT && !isExcludedPath) {
      reasoningTrace.push(`Warning: ${consoleCount} console statements found`);
      suggestions.push('Remove console statements before production');
      issues++;
    }

    // Architectural Contracts Evaluation
    const contractViolations = this.contractEngine.evaluate(options.filePath, options.code);
    let hasContractError = false;
    if (contractViolations.length > 0) {
      for (const violation of contractViolations) {
        reasoningTrace.push(
          `[Contract ${violation.severity.toUpperCase()}] ${violation.contractName}: ${violation.message}${violation.line ? ` (line ${violation.line})` : ''}`,
        );
        suggestions.push(`Fix architectural contract violation: ${violation.message}`);
        if (violation.severity === 'error') {
          hasContractError = true;
          issues += 3;
        } else {
          issues += 1;
        }
      }
    }

    reasoningTrace.push(`Fast-tier analysis complete. Issues found: ${issues}`);

    const verdict = hasContractError
      ? 'fail'
      : issues === 0
        ? 'pass'
        : issues > 2
          ? 'fail'
          : 'warn';
    const confidence = Math.max(0.3, 0.9 - issues * 0.15);

    const result: CoherenceResult = {
      verdict,
      confidence,
      reasoningTrace,
      suggestions,
      llmProvider: 'fast-tier',
      responseTimeMs: Date.now() - startTime,
    };

    this.cache.set(cacheKey, result);
    this.storeDecision(this.hashCode(options.code), result, options.filePath);

    return result;
  }

  private storeDecision(codeHash: string, result: CoherenceResult, filePath: string): void {
    const fileRow = this.db.prepare('SELECT id FROM files WHERE path = ?').get(filePath) as
      { id: number } | undefined;
    const reasoningJson = JSON.stringify(result.reasoningTrace);
    const suggestionsJson = JSON.stringify(result.suggestions);

    const existing = this.db
      .prepare('SELECT id FROM coherence_decisions WHERE code_hash = ?')
      .get(codeHash) as { id: number } | undefined;

    if (existing) {
      this.db
        .prepare(
          `UPDATE coherence_decisions SET verdict = ?, confidence = ?, reasoning_trace = ?, suggestions = ?, 
           llm_provider = ?, response_time_ms = ?, analyzed_at = CURRENT_TIMESTAMP WHERE id = ?`,
        )
        .run(
          result.verdict,
          result.confidence,
          reasoningJson,
          suggestionsJson,
          result.llmProvider,
          result.responseTimeMs,
          existing.id,
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO coherence_decisions 
           (file_id, code_hash, verdict, confidence, reasoning_trace, suggestions, llm_provider, response_time_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          fileRow?.id ?? null,
          codeHash,
          result.verdict,
          result.confidence,
          reasoningJson,
          suggestionsJson,
          result.llmProvider,
          result.responseTimeMs,
        );
    }
  }

  /** Kept as thin alias — single crypto-backed implementation in utils/hash. */
  /**
   * Perform semantic analysis on the code.
   */
  private semanticAnalysis(
    code: string,
    filePath: string,
  ): {
    issues: number;
    reasoningTrace: string[];
    suggestions: string[];
  } {
    const reasoningTrace: string[] = [];
    const suggestions: string[] = [];
    let issues = 0;

    // Check for naming conventions. Keep these expressions deliberately
    // narrow: a broad arrow-function regex can consume TypeScript union types
    // (for example `Provider = 'simple' | 'openai'`) and report a false
    // naming violation. Function declarations and variable-bound arrows are
    // the two shapes we can identify reliably without a full AST here.
    const functionNames = Array.from(
      code.matchAll(/function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g),
      (match) => match[1]!,
    );
    const arrowFunctionNames = Array.from(
      code.matchAll(
        /(?:^|[;\n])\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?(?:\([^\n)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>/gm,
      ),
      (match) => match[1]!,
    );
    const allFunctionNames = [...functionNames, ...arrowFunctionNames];
    const nonCamelCaseFunctions = allFunctionNames.filter(
      (name) => !/^[a-z][A-Za-z0-9_$]*$/.test(name),
    ).length;

    if (nonCamelCaseFunctions > 0) {
      reasoningTrace.push(
        `Warning: ${nonCamelCaseFunctions} functions do not follow camelCase naming convention`,
      );
      suggestions.push('Rename functions to follow camelCase convention');
      issues += nonCamelCaseFunctions;
    }

    // Check for unused variables
    const variableMatches = code.match(/const\s+([a-zA-Z0-9_]+)\s*=/g) || [];
    const letMatches = code.match(/let\s+([a-zA-Z0-9_]+)\s*=/g) || [];
    const allVariables = [...variableMatches, ...letMatches];

    const usedVariables = allVariables.filter((declaration) => {
      const match = /^(?:const|let)\s+([A-Za-z0-9_$]+)\s*=/.exec(declaration);
      if (!match) return true;
      const varName = match[1]!;
      const declarationPattern = new RegExp(
        `\\b(?:const|let)\\s+${escapeRegExp(varName)}\\s*=`,
        'g',
      );
      const codeWithoutDeclarations = code.replace(declarationPattern, '');
      return codeWithoutDeclarations.includes(varName) && !code.includes(`// ${varName} unused`);
    });

    const unusedVariables = allVariables.length - usedVariables.length;
    if (unusedVariables > 0) {
      reasoningTrace.push(`Warning: ${unusedVariables} unused variables detected`);
      suggestions.push('Remove unused variables or mark them with `// variable unused`');
      issues += unusedVariables;
    }

    // Check for complex functions (cyclomatic complexity)
    const sourceFile = ts.createSourceFile(
      filePath,
      code,
      ts.ScriptTarget.Latest,
      true,
      scriptKindFor(filePath),
    );
    const complexFunctions: ts.Node[] = [];
    const collectComplexFunctions = (node: ts.Node): void => {
      if (ts.isFunctionLike(node) && calculateCyclomaticComplexity(node) > MAX_DECISION_POINTS) {
        complexFunctions.push(node);
      }
      ts.forEachChild(node, collectComplexFunctions);
    };
    collectComplexFunctions(sourceFile);

    if (complexFunctions.length > 0) {
      reasoningTrace.push(
        `Warning: ${complexFunctions.length} functions with high cyclomatic complexity (>${MAX_DECISION_POINTS} decision points)`,
      );
      suggestions.push('Refactor complex functions into smaller, more manageable pieces');
      issues += complexFunctions.length;
    }

    return { issues, reasoningTrace, suggestions };
  }

  private hashCode(str: string): string {
    return stableHash(str);
  }
}

/**
 * Count explicit `any` type annotations with the TypeScript AST.
 *
 * This deliberately does not infer whether a type is "good" or "bad"; it
 * only reports syntax that is objectively an explicit AnyKeyword. Comments,
 * strings and prose such as "Replace any with unknown" are not AST nodes of
 * that kind and therefore cannot inflate the result.
 */
function countExplicitAnyTypes(code: string, filePath: string): number {
  const lowerPath = filePath.toLowerCase();
  const scriptKind = lowerPath.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : lowerPath.endsWith('.jsx')
      ? ts.ScriptKind.JSX
      : lowerPath.endsWith('.js') || lowerPath.endsWith('.mjs') || lowerPath.endsWith('.cjs')
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true, scriptKind);
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.AnyKeyword) count++;
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return count;
}

function scriptKindFor(filePath: string): ts.ScriptKind {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (lower.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}
