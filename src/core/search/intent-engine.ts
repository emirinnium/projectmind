import type { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type {
  IntentQuery,
  IntentType,
  HybridScore,
  SearchResult,
  SemanticEvidence,
} from './types.js';
import { VecIndex, getVecIndex } from '../embeddings/vector-index.js';
import { generateEmbedding, codeToEmbeddingAsync } from '../../parser/embeddings.js';
import { logger } from '../../utils/logger.js';
import { loadConfig } from '../../utils/config.js';
import { executeIntentSearch, type SemanticSearchCandidate } from './intent-search.js';
import type { KGGraphLike } from './graph-adapter.js';
import { cosineSimilarity, safeScore } from './scoring.js';

export { createKgGraphAdapter } from './graph-adapter.js';
export type { KGGraphLike, KgAdapterSource } from './graph-adapter.js';
export { classifyTask, TASK_KEYWORDS } from './task-classifier.js';
export { cosineSimilarity } from './scoring.js';

const SIMILARITY_THRESHOLD = 0.5;
const RANK_DECAY_FACTOR = 0.15;
const MAX_SIMILAR_RESULTS = 10;

export class IntentEngine {
  private readonly vecIndex?: VecIndex;
  private readonly db?: DatabaseSync;
  private readonly projectRoot?: string;
  private readonly embeddingDimension: number;
  public weights = { semantic: 0.4, structural: 0.3, intent: 0.3 };

  constructor(options?: {
    vecIndex?: VecIndex;
    db?: DatabaseSync;
    weights?: Partial<typeof IntentEngine.prototype.weights>;
    /** Absolute project root; relative file paths are resolved against it
     *  before reading, so servers whose CWD differs from the project root
     *  (e.g. MCP) do not silently score 0 / return empty snippets. */
    projectRoot?: string;
  }) {
    this.embeddingDimension = loadConfig().embeddings.dimension;
    if (options?.vecIndex) {
      this.vecIndex = options.vecIndex;
    } else if (options?.db) {
      this.db = options.db;
      this.vecIndex = getVecIndex(options.db, this.embeddingDimension);
    }
    if (options?.weights) {
      this.weights = { ...this.weights, ...options.weights };
    }
    if (options?.projectRoot) {
      this.projectRoot = options.projectRoot;
    }
  }

  /**
   * Resolve a possibly-relative file path against the configured project
   * root, confined to the project root. KG paths are root-relative; engines
   * without a root keep the historical (CWD-relative) behavior.
   *
   * SECURITY: client-supplied paths (e.g. the MCP search_intent filePath)
   * are untrusted. After path.resolve, the result must still be contained in
   * the project root — otherwise ('../SECRET.txt', absolute paths outside)
   * return undefined so callers degrade to no-snippet/zero score instead of
   * leaking file content. Works on Windows (path.sep containment check).
   */
  private resolveFilePath(filePath: string): string | undefined {
    if (!this.projectRoot) return filePath;
    const rootResolved = resolve(this.projectRoot);
    const result = resolve(rootResolved, filePath);
    if (result !== rootResolved && !result.startsWith(rootResolved + sep)) return undefined;
    return result;
  }

  private readonly intentKeywords: Record<IntentType, string[]> = {
    read: [
      'read',
      'find',
      'search',
      'locate',
      'discover',
      'view',
      'show',
      'get',
      'fetch',
      'query',
      'select',
      'db',
    ],
    write: [
      'write',
      'create',
      'add',
      'insert',
      'modify',
      'update',
      'edit',
      'generate',
      'produce',
      'save',
      'delete',
    ],
    validate: [
      'validate',
      'check',
      'verify',
      'test',
      'lint',
      'audit',
      'inspect',
      'ensure',
      'confirm',
      'assert',
      'guard',
    ],
    transform: [
      'transform',
      'convert',
      'refactor',
      'rewrite',
      'migrate',
      'change',
      'adapt',
      'restructure',
      'map',
      'parse',
      'serialize',
    ],
  };

  private resolveQueryText(query: IntentQuery): string {
    if (
      query.naturalLanguage !== undefined &&
      query.naturalLanguage !== null &&
      query.naturalLanguage !== ''
    ) {
      return query.naturalLanguage;
    }
    if (query.text !== undefined && query.text !== null && query.text !== '') {
      return query.text;
    }
    throw new Error('IntentQuery requires naturalLanguage or deprecated text');
  }

  classifyIntent(query: IntentQuery): IntentType {
    const text = (
      this.resolveQueryText(query) +
      ' ' +
      (query.context || '') +
      ' ' +
      (query.structuralHints?.join(' ') || '') +
      ' ' +
      (query.expectedOutputs?.join(' ') || '')
    ).toLowerCase();
    const scores: Record<IntentType, number> = { read: 0, write: 0, validate: 0, transform: 0 };
    for (const [intent, keywords] of Object.entries(this.intentKeywords)) {
      for (const kw of keywords) {
        if (text.includes(kw)) scores[intent as IntentType] += 1;
      }
    }
    if (query.filePath) {
      const p = query.filePath.toLowerCase();
      if (p.includes('.test.') || p.includes('.spec.')) scores.validate += 2;
      if (p.includes('refactor') || p.includes('migrate')) scores.transform += 2;
    }
    let best: IntentType = 'read';
    let bestScore = -1;
    for (const [intent, score] of Object.entries(scores)) {
      if (score > bestScore) {
        bestScore = score;
        best = intent as IntentType;
      }
    }
    return best;
  }

  // F3: score FILE CONTENT, not query text
  intentScore(intent: IntentType, filePath: string): number {
    try {
      const resolved = this.resolveFilePath(filePath);
      if (!resolved) return 0; // outside project root — treat as unreadable
      const content = readFileSync(resolved, 'utf-8');
      const kb = content.length / 1024 || 0.001;
      const markers = this.getMarkers(intent, content);
      const density = markers / kb;
      return Math.min(1, Math.round(density * 10) / 10); // cap at 1, scale roughly
    } catch {
      return 0;
    }
  }

  private getMarkers(intent: IntentType, content: string): number {
    const lines = content.split(/\r?\n/);
    let hits = 0;
    if (intent === 'read') {
      for (const line of lines) {
        if (/\b(readFileSync|readFile|db\.select|db\.query|get\(|fetch\(|find\()\b/.test(line))
          hits++;
      }
    } else if (intent === 'write') {
      for (const line of lines) {
        if (/\b(writeFileSync|writeFile|insert|update|delete|save\(|create\()\b/.test(line)) hits++;
      }
    } else if (intent === 'validate') {
      for (const line of lines) {
        if (
          /\b(if\s*\(.*\)\s*throw|assert\(|expect\(|z\.\w+|is[A-Z]\w+\(|type\s+guard)\b/.test(line)
        )
          hits++;
      }
    } else if (intent === 'transform') {
      for (const line of lines) {
        if (/\b(map\(|parse\(|serialize\(|transform\(|convert\()\b/.test(line)) hits++;
      }
    }
    return hits;
  }

  // F4: semantic scoring with real embeddings + lexical fallback
  async computeSemanticScore(
    queryText: string,
    filePath: string,
  ): Promise<{
    score: number;
    source: 'embedding' | 'lexical';
    semanticEvidence: SemanticEvidence;
  }> {
    const readablePath = this.resolveFilePath(filePath);
    try {
      // Outside the project root — never read it; degrade to a zero lexical score.
      if (!readablePath) return { score: 0, source: 'lexical', semanticEvidence: 'lexical' };
      const queryEmb = await generateEmbedding(queryText, this.embeddingDimension);
      // If we have a file, try to embed file content and compare
      const fileContent = readFileSync(readablePath, 'utf-8');
      const fileEmb = await codeToEmbeddingAsync(fileContent, this.embeddingDimension);
      const sim = cosineSimilarity(queryEmb, fileEmb);
      return {
        score: safeScore(sim) ?? 0,
        source: 'embedding',
        semanticEvidence: 'measured',
      };
    } catch (e) {
      // Graceful lexical fallback
      logger.warn(
        `Embedding-based semantic score failed, falling back to lexical: ${e instanceof Error ? e.message : String(e)}`,
      );
      const queryTokens = new Set(queryText.toLowerCase().split(/\W+/).filter(Boolean));
      let fileContent = '';
      try {
        if (readablePath) fileContent = readFileSync(readablePath, 'utf-8');
      } catch (e) {
        logger.warn(
          `Failed to read file for lexical fallback: ${e instanceof Error ? e.message : String(e)}`,
          { filePath: readablePath ?? 'unknown' },
        );
      }
      const fileTokens = new Set(fileContent.toLowerCase().split(/\W+/).filter(Boolean));
      const intersection = new Set([...queryTokens].filter((t) => fileTokens.has(t)));
      const union = new Set([...queryTokens, ...fileTokens]);
      const jaccard = union.size > 0 ? intersection.size / union.size : 0;
      return { score: Math.min(1, jaccard), source: 'lexical', semanticEvidence: 'lexical' };
    }
  }

  computeHybridScore(
    query: IntentQuery,
    filePath: string,
    kgGraph: KGGraphLike,
    semanticScore?: number,
    _semanticSource?: 'embedding' | 'lexical',
  ): HybridScore {
    const intentType = this.classifyIntent(query);
    const intentScore = this.intentScore(intentType, filePath);

    // F5: structural = KG graph relatedness (shared imports/dependents with seed files)
    let structuralScore = 0.3;
    try {
      const fileInfo = kgGraph.getFileByPath(filePath);
      if (fileInfo && typeof fileInfo.id === 'number') {
        const imports = kgGraph.getImports ? kgGraph.getImports(fileInfo.id) : [];
        const dependents = kgGraph.getDependents ? kgGraph.getDependents(fileInfo.id) : [];
        // Relatedness = shared connections normalized
        const totalConnections = imports.length + dependents.length;
        structuralScore = Math.min(1, 0.3 + totalConnections * 0.08);
      } else if (fileInfo) {
        structuralScore = 0.4;
      }
    } catch {
      structuralScore = 0.3;
    }

    const sem = safeScore(semanticScore ?? SIMILARITY_THRESHOLD) ?? 0;
    const structural = safeScore(structuralScore) ?? 0;
    const intentComponent = safeScore(intentScore) ?? 0;
    const total =
      this.weights.semantic * sem +
      this.weights.structural * structural +
      this.weights.intent * intentComponent;
    return {
      semantic: sem,
      structural,
      intent: intentComponent,
      total: safeScore(Math.round(total * 100) / 100) ?? 0,
    };
  }

  // F4: fix KG adapter — findSimilarFiles returns FileInfo[] WITHOUT score; derive from rank
  deriveSemanticFromSimilar(
    similarResults: Array<{ path: string; score?: number }>,
  ): SemanticSearchCandidate[] {
    const out: SemanticSearchCandidate[] = [];
    for (let i = 0; i < similarResults.length; i++) {
      const rank = i + 1;
      const derived = Math.max(0, 1 - (rank - 1) * RANK_DECAY_FACTOR); // 1→1.0, 2→0.85, 3→0.7...
      const measured = safeScore(similarResults[i].score);
      out.push({
        path: similarResults[i].path,
        score: measured ?? derived,
        source: 'embedding',
        semanticEvidence: measured === undefined ? 'rank-derived' : 'measured',
      });
    }
    return out;
  }

  async search(
    query: IntentQuery,
    kgGraph?: KGGraphLike,
    limit = MAX_SIMILAR_RESULTS,
  ): Promise<SearchResult[]> {
    return executeIntentSearch(
      {
        embeddingDimension: this.embeddingDimension,
        vecIndex: this.vecIndex,
        db: this.db,
        generateEmbedding,
        resolveQueryText: (intentQuery) => this.resolveQueryText(intentQuery),
        classifyIntent: (intentQuery) => this.classifyIntent(intentQuery),
        computeSemanticScore: (queryText, filePath) =>
          this.computeSemanticScore(queryText, filePath),
        computeHybridScore: (intentQuery, filePath, graph, semanticScore, semanticSource) =>
          this.computeHybridScore(intentQuery, filePath, graph, semanticScore, semanticSource),
        deriveSemanticFromSimilar: (similarResults) =>
          this.deriveSemanticFromSimilar(similarResults),
        resolveFilePath: (filePath) => this.resolveFilePath(filePath),
        getMarkers: (intentType, content) => this.getMarkers(intentType, content),
      },
      query,
      kgGraph,
      limit,
    );
  }
}
