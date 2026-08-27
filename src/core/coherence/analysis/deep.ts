import type { LLMProvider, LLMResponse, CoherenceResult, CoherenceCheckOptions } from './fast.js';
import { DatabaseSync } from 'node:sqlite';
import { CoherenceCache } from '../../cache/index.js';
import { runWithRetry } from '../../../storage/database.js';
import { logger } from '../../../utils/logger.js';
import { stableHash } from '../../../utils/hash.js';

// Warning tracking to avoid spamming user
let cloudLLMWarningShown = false;

/**
 * Handles deep LLM-based coherence analysis
 */
export class DeepCoherenceAnalyzer {
  private llmProvider: LLMProvider | null = null;
  private cache: CoherenceCache;
  private db: DatabaseSync;
  private allowCloudLLM: boolean = false;

  constructor(db: DatabaseSync, cache: CoherenceCache) {
    this.db = db;
    this.cache = cache;
  }

  setLLMProvider(provider: LLMProvider): void {
    this.llmProvider = provider;
  }

  /**
   * Set whether cloud LLM usage is allowed.
   * When false (default), a warning is shown before sending code to cloud LLM.
   */
  setAllowCloudLLM(allow: boolean): void {
    this.allowCloudLLM = allow;
  }

  /**
   * Show a one-time warning about code being sent to cloud LLM.
   */
  private showCloudLLMWarning(): void {
    if (cloudLLMWarningShown || this.allowCloudLLM) {
      return;
    }
    cloudLLMWarningShown = true;
    logger.warn(`SECURITY WARNING: Code will be sent to cloud LLM API`);
    logger.warn(`Provider: ${this.llmProvider?.name || 'unknown'}`);
    logger.warn(`Set PROJECTMIND_ALLOW_CLOUD_LLM=true to suppress.`);
  }

  async analyze(options: CoherenceCheckOptions, cacheKey: string): Promise<CoherenceResult> {
    const startTime = Date.now();

    // Show warning before sending code to cloud
    this.showCloudLLMWarning();

    // Check environment variable as fallback
    if (process.env.PROJECTMIND_ALLOW_CLOUD_LLM === 'true') {
      this.allowCloudLLM = true;
    }

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

  /**
   * Parse structured data from LLM response.
   */
  private parseStructuredData<T>(content: string, key: string, parser: (text: string) => T): T | null {
    const startIndex = content.indexOf(`${key}:`);
    if (startIndex === -1) return null;
    
    const endIndex = content.indexOf('\n\n', startIndex);
    const section = endIndex === -1 ? content.substring(startIndex) : content.substring(startIndex, endIndex);
    
    try {
      return parser(section.substring(key.length + 1).trim());
    } catch {
      return null;
    }
  }

  private parseLLMResponse(
    response: LLMResponse,
    startTime: number
  ): CoherenceResult {
    const content = response.content;
    let verdict: 'pass' | 'warn' | 'fail' = 'warn';
    let confidence = 0.5;
    let suggestions: string[] = [];
    let reasoningTrace: string[] = response.reasoningTrace;

    // Parse verdict
    const verdictText = this.parseStructuredData(content, 'VERDICT', (text) => {
      const match = text.match(/(pass|warn|fail)/i);
      return match ? match[1].toLowerCase() as 'pass' | 'warn' | 'fail' : 'warn';
    });
    if (verdictText) verdict = verdictText;

    // Parse confidence
    const confidenceText = this.parseStructuredData(content, 'CONFIDENCE', (text) => {
      const num = parseFloat(text);
      return isNaN(num) ? 0.5 : Math.min(1.0, Math.max(0.0, num));
    });
    if (confidenceText) confidence = confidenceText;

    // Parse reasoning trace
    const reasoningText = this.parseStructuredData(content, 'REASONING_TRACE', (text) => {
      return text.split('\n').map(line => line.trim()).filter(line => line.length > 0);
    });
    if (reasoningText) reasoningTrace = reasoningText;

    // Parse suggestions
    const suggestionsText = this.parseStructuredData(content, 'SUGGESTIONS', (text) => {
      return text.split('\n').map(line => line.trim()).filter(line => line.length > 0 && !line.startsWith('- '));
    });
    if (suggestionsText) suggestions = suggestionsText.slice(0, 5);

    // Fallback parsing if structured data is missing
    if (!verdictText || !confidenceText) {
      const verdictMatch = content.match(/VERDICT:\s*(pass|warn|fail)/i);
      const confidenceMatch = content.match(/CONFIDENCE:\s*([\d.]+)/i);
      
      if (verdictMatch) verdict = verdictMatch[1].toLowerCase() as 'pass' | 'warn' | 'fail';
      if (confidenceMatch) confidence = parseFloat(confidenceMatch[1]);
      
      const suggestionsStart = content.indexOf('SUGGESTIONS:');
      if (suggestionsStart >= 0) {
        const suggestionsText = content.substring(suggestionsStart + 'SUGGESTIONS:'.length);
        suggestions = suggestionsText.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 5);
      }
    }

    return {
      verdict,
      confidence,
      reasoningTrace,
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

  /** Kept as thin alias — single crypto-backed implementation in utils/hash. */
  private hashCode(str: string): string {
    return stableHash(str);
  }
}