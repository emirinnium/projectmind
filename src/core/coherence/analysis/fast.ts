import { DatabaseSync } from 'node:sqlite';
import { CoherenceCache } from '../../cache/index.js';
import { FileInfo } from '../../../storage/knowledge-graph.js';
import { ContractEngine } from '../../contracts/engine.js';
import { stableHash } from '../../../utils/hash.js';

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
}

export interface CoherenceResult {
  verdict: 'pass' | 'warn' | 'fail';
  confidence: number;
  reasoningTrace: string[];
  suggestions: string[];
  llmProvider: string;
  responseTimeMs: number;
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

    const lines = options.code.split('\n');
    reasoningTrace.push(`Line count: ${lines.length}`);

    let issues = 0;
    const suggestions: string[] = [];

    if (lines.length > 400) {
      reasoningTrace.push(`Warning: File exceeds 400 lines (${lines.length}) — cognitive load concern`);
      suggestions.push('Consider splitting this file into smaller modules');
      issues++;
    }

    const importCount = (options.code.match(/^\s*import\s+/gm) || []).length;
    if (importCount > 20) {
      reasoningTrace.push(`Warning: High import count (${importCount}) — potential coupling issue`);
      suggestions.push('Review imports for unnecessary dependencies');
      issues++;
    }

    const anyUsage = (options.code.match(/\bany\b/g) || []).length;
    if (anyUsage > 5) {
      reasoningTrace.push(`Warning: Found ${anyUsage} uses of "any" — type safety concern`);
      suggestions.push('Replace "any" with specific types or unknown');
      issues++;
    }

    const consoleCount = (options.code.match(/console\.\w+/g) || []).length;
    const isExcludedPath = options.filePath.includes('/cli/commands/') || options.filePath.includes('\\cli\\commands\\') || options.filePath.includes('/scripts/') || options.filePath.includes('\\scripts\\') || options.filePath.includes('/tests/') || options.filePath.includes('\\tests\\');
    if (consoleCount > 3 && !isExcludedPath) {
      reasoningTrace.push(`Warning: ${consoleCount} console statements found`);
      suggestions.push('Remove console statements before production');
      issues++;
    }

    // Architectural Contracts Evaluation
    const contractViolations = this.contractEngine.evaluate(options.filePath, options.code);
    let hasContractError = false;
    if (contractViolations.length > 0) {
      for (const violation of contractViolations) {
        reasoningTrace.push(`[Contract ${violation.severity.toUpperCase()}] ${violation.contractName}: ${violation.message}${violation.line ? ` (line ${violation.line})` : ''}`);
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

    const verdict = hasContractError ? 'fail' : issues === 0 ? 'pass' : issues > 2 ? 'fail' : 'warn';
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
    const fileRow = this.db.prepare('SELECT id FROM files WHERE path = ?').get(filePath) as { id: number } | undefined;
    const reasoningJson = JSON.stringify(result.reasoningTrace);
    const suggestionsJson = JSON.stringify(result.suggestions);

    const existing = this.db.prepare('SELECT id FROM coherence_decisions WHERE code_hash = ?').get(codeHash) as { id: number } | undefined;

    if (existing) {
      this.db
        .prepare(
          `UPDATE coherence_decisions SET verdict = ?, confidence = ?, reasoning_trace = ?, suggestions = ?, 
           llm_provider = ?, response_time_ms = ?, analyzed_at = CURRENT_TIMESTAMP WHERE id = ?`
        )
        .run(result.verdict, result.confidence, reasoningJson, suggestionsJson, result.llmProvider, result.responseTimeMs, existing.id);
    } else {
      this.db
        .prepare(
          `INSERT INTO coherence_decisions 
           (file_id, code_hash, verdict, confidence, reasoning_trace, suggestions, llm_provider, response_time_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          fileRow?.id ?? null,
          codeHash,
          result.verdict,
          result.confidence,
          reasoningJson,
          suggestionsJson,
          result.llmProvider,
          result.responseTimeMs
        );
    }
  }

  /** Kept as thin alias — single crypto-backed implementation in utils/hash. */
  private hashCode(str: string): string {
    return stableHash(str);
  }
}