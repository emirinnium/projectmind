import type { LLMProvider, LLMResponse, CoherenceResult, CoherenceCheckOptions } from './fast.js';
import { DatabaseSync } from 'node:sqlite';
import { CoherenceCache } from '../../cache/index.js';
import { runWithRetry } from '../../../storage/database.js';

/**
 * Handles deep LLM-based coherence analysis
 */
export class DeepCoherenceAnalyzer {
  private llmProvider: LLMProvider | null = null;
  private cache: CoherenceCache;
  private db: DatabaseSync;

  constructor(db: DatabaseSync, cache: CoherenceCache) {
    this.db = db;
    this.cache = cache;
  }

  setLLMProvider(provider: LLMProvider): void {
    this.llmProvider = provider;
  }

  async analyze(options: CoherenceCheckOptions, cacheKey: string): Promise<CoherenceResult> {
    const startTime = Date.now();

    const contextSummary = options.contextFiles
      ?.slice(0, 5)
      .map((f) => `File: ${f.relativePath} (language: ${f.language}, load: ${f.cognitiveLoad})`)
      .join('\n') ?? 'No additional context';

    const systemPrompt = `You are ProjectMind's Coherence Engine. 
Analyze this code change for semantic coherence, architectural consistency, and best practices. Think step-by-step.

1. What architectural pattern does this code follow?
2. Does it match or contradict existing patterns in the context provided?
3. Are there potential issues with error handling, type safety, or maintainability?
4. What are the consequences of this approach at scale?

Output your reasoning as numbered steps, then a verdict.`;

    const prompt = `CODE TO ANALYZE:
File: ${options.filePath}
Code: ${options.code}

CONTEXT:
${contextSummary}

Output:
REASONING_TRACE: (step-by-step analysis, numbered)
VERDICT: pass|warn|fail
CONFIDENCE: 0.0-1.0
SUGGESTIONS: (one per line, or "none")`;

    const response = await runWithRetry(
      async () => this.llmProvider!.analyze(prompt, systemPrompt, 0.3),
      {
        maxAttempts: 3,
        baseDelayMs: 1000,
        maxDelayMs: 5000,
        retryableErrors: ['timeout', 'network', 'ECONNREFUSED', 'ETIMEDOUT', 'rate limit', '429', '500', '502', '503'],
      }
    );
    const result = this.parseLLMResponse(response, startTime);

    this.cache.set(cacheKey, result);
    this.storeDecision(this.hashCode(options.code), result, options.filePath);

    return result;
  }

  private parseLLMResponse(
    response: LLMResponse,
    startTime: number
  ): CoherenceResult {
    const content = response.content;

    const verdictMatch = content.match(/VERDICT:\s*(pass|warn|fail)/i);
    const confidenceMatch = content.match(/CONFIDENCE:\s*([\d.]+)/i);

    const suggestionsStart = content.indexOf('SUGGESTIONS:');
    let suggestions: string[] = [];
    if (suggestionsStart >= 0) {
      const suggestionsText = content.substring(suggestionsStart + 'SUGGESTIONS:'.length);
      suggestions = suggestionsText.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 5);
    }

    const verdict = (verdictMatch?.[1]?.toLowerCase() as 'pass' | 'warn' | 'fail') ?? 'warn';
    const confidence = confidenceMatch ? parseFloat(confidenceMatch[1]) : 0.5;

    return {
      verdict,
      confidence,
      reasoningTrace: response.reasoningTrace,
      suggestions,
      llmProvider: response.reasoningTrace.length > 5 ? 'deep-tier(llm)' : 'fast-tier',
      responseTimeMs: Date.now() - startTime,
    };
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

  private hashCode(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return Math.abs(hash).toString(16);
  }
}