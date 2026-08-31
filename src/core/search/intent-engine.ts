import type { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { IntentQuery, IntentType, HybridScore, SearchResult, TaskType } from './types.js';
import { VecIndex, getVecIndex } from '../embeddings/vector-index.js';
import { generateEmbedding, codeToEmbeddingAsync } from '../../parser/embeddings.js';

const DEFAULT_DIMENSION = 768;

export interface KGGraphLike {
  getFileByPath(path: string): { id?: number; path: string } | null;
  getImports?(fileId: number): Array<{ source: string; named: string[]; kind: string }>;
  getDependents?(fileId: number): Array<{ source: string; named: string[]; kind: string }>;
  findSimilarFiles?(embedding: number[], threshold?: number, limit?: number): Array<{ path: string; score?: number }>;
}

/**
 * Minimal structural surface of KnowledgeGraph that the adapter consumes.
 * Kept structural (no storage import) so core stays independent of storage.
 */
export interface KgAdapterSource {
  getFileByPath(path: string): { id?: number; path?: string; relativePath?: string } | null;
  getImports?(fileId: number): Array<{ source: string; named?: string[]; kind?: string }>;
  getDependents?(fileId: number): Array<{ path?: string; relativePath?: string }>;
  findSimilarFiles?(embedding: number[], threshold?: number, limit?: number): Array<{ path?: string; relativePath?: string }>;
}

/**
 * Adapt a KnowledgeGraph-shaped object to the {@link KGGraphLike} contract
 * expected by {@link IntentEngine.search}. KnowledgeGraph.getDependents
 * returns file records (not import rows), so dependent paths are mapped to
 * `source` entries the engine can seed structural expansion from.
 */
export function createKgGraphAdapter(kg: KgAdapterSource): KGGraphLike {
  return {
    getFileByPath: (p) => {
      const f = kg.getFileByPath(p);
      if (!f) return null;
      return { id: f.id, path: f.relativePath ?? f.path ?? p };
    },
    getImports: kg.getImports
      ? (fileId) =>
          kg.getImports!(fileId).map((i) => ({
            source: i.source,
            named: i.named ?? [],
            kind: i.kind ?? 'import',
          }))
      : undefined,
    getDependents: kg.getDependents
      ? (fileId) =>
          kg.getDependents!(fileId).map((d) => ({
            source: d.relativePath ?? d.path ?? '',
            named: [],
            kind: 'import',
          }))
      : undefined,
    findSimilarFiles: kg.findSimilarFiles
      ? (embedding, threshold, limit) =>
          kg.findSimilarFiles!(embedding, threshold, limit).map((f) => ({
            path: f.relativePath ?? f.path ?? '',
          }))
      : undefined,
  };
}

export const TASK_KEYWORDS: Record<TaskType, string[]> = {
  'bug fix': ['fix', 'bug', 'error', 'crash', 'defect', 'issue', 'broken', 'fail'],
  feature: ['add', 'new', 'feature', 'implement', 'support', 'create', 'build', 'introduce'],
  refactor: ['refactor', 'cleanup', 'restructure', 'extract', 'simplify', 'reorganize', 'optimize'],
  test: ['test', 'coverage', 'spec', 'assert', 'verify', 'check', 'validate', 'lint'],
};

export function classifyTask(queryText: string): TaskType {
  const text = queryText.toLowerCase();
  const scores: Record<TaskType, number> = {
    'bug fix': 0,
    feature: 0,
    refactor: 0,
    test: 0,
  };
  for (const [task, kws] of Object.entries(TASK_KEYWORDS)) {
    for (const kw of kws) {
      if (text.includes(kw)) scores[task as TaskType] += 1;
    }
  }
  // Heuristic tie-break: if multiple, pick highest; default feature
  let best: TaskType = 'feature';
  let bestScore = -1;
  for (const [t, s] of Object.entries(scores)) {
    if (s > bestScore) {
      bestScore = s;
      best = t as TaskType;
    }
  }
  if (bestScore <= 0) best = 'feature';
  return best;
}

export class IntentEngine {
  private readonly vecIndex?: VecIndex;
  private readonly db?: DatabaseSync;
  private readonly projectRoot?: string;
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
    if (options?.vecIndex) {
      this.vecIndex = options.vecIndex;
    } else if (options?.db) {
      this.db = options.db;
      this.vecIndex = getVecIndex(options.db);
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
    read: ['read', 'find', 'search', 'locate', 'discover', 'view', 'show', 'get', 'fetch', 'query', 'select', 'db'],
    write: ['write', 'create', 'add', 'insert', 'modify', 'update', 'edit', 'generate', 'produce', 'save', 'delete'],
    validate: ['validate', 'check', 'verify', 'test', 'lint', 'audit', 'inspect', 'ensure', 'confirm', 'assert', 'guard'],
    transform: ['transform', 'convert', 'refactor', 'rewrite', 'migrate', 'change', 'adapt', 'restructure', 'map', 'parse', 'serialize'],
  };

  private resolveQueryText(query: IntentQuery): string {
    if (query.naturalLanguage !== undefined && query.naturalLanguage !== null && query.naturalLanguage !== '') {
      return query.naturalLanguage;
    }
    if (query.text !== undefined && query.text !== null && query.text !== '') {
      return query.text;
    }
    throw new Error('IntentQuery requires naturalLanguage or deprecated text');
  }

  classifyIntent(query: IntentQuery): IntentType {
    const text = (this.resolveQueryText(query) + ' ' + (query.context || '') + ' ' + (query.structuralHints?.join(' ') || '') + ' ' + (query.expectedOutputs?.join(' ') || '')).toLowerCase();
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
      if (score > bestScore) { bestScore = score; best = intent as IntentType; }
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
        if (/\b(readFileSync|readFile|db\.select|db\.query|get\(|fetch\(|find\()\b/.test(line)) hits++;
      }
    } else if (intent === 'write') {
      for (const line of lines) {
        if (/\b(writeFileSync|writeFile|insert|update|delete|save\(|create\()\b/.test(line)) hits++;
      }
    } else if (intent === 'validate') {
      for (const line of lines) {
        if (/\b(if\s*\(.*\)\s*throw|assert\(|expect\(|z\.\w+|is[A-Z]\w+\(|type\s+guard)\b/.test(line)) hits++;
      }
    } else if (intent === 'transform') {
      for (const line of lines) {
        if (/\b(map\(|parse\(|serialize\(|transform\(|convert\()\b/.test(line)) hits++;
      }
    }
    return hits;
  }

  // F4: semantic scoring with real embeddings + lexical fallback
  async computeSemanticScore(queryText: string, filePath: string): Promise<{ score: number; source: 'embedding' | 'lexical' }> {
    const readablePath = this.resolveFilePath(filePath);
    try {
      // Outside the project root — never read it; degrade to a zero lexical score.
      if (!readablePath) return { score: 0, source: 'lexical' };
      const queryEmb = await generateEmbedding(queryText, DEFAULT_DIMENSION);
      // If we have a file, try to embed file content and compare
      const fileContent = readFileSync(readablePath, 'utf-8');
      const fileEmb = await codeToEmbeddingAsync(fileContent, DEFAULT_DIMENSION);
      const sim = cosineSimilarity(queryEmb, fileEmb);
      return { score: Math.max(0, Math.min(1, sim)), source: 'embedding' };
    } catch {
      // Graceful lexical fallback
      const queryTokens = new Set(queryText.toLowerCase().split(/\W+/).filter(Boolean));
      let fileContent = '';
      try { if (readablePath) fileContent = readFileSync(readablePath, 'utf-8'); } catch { /* ignore */ }
      const fileTokens = new Set(fileContent.toLowerCase().split(/\W+/).filter(Boolean));
      const intersection = new Set([...queryTokens].filter(t => fileTokens.has(t)));
      const union = new Set([...queryTokens, ...fileTokens]);
      const jaccard = union.size > 0 ? intersection.size / union.size : 0;
      return { score: Math.min(1, jaccard), source: 'lexical' };
    }
  }

  computeHybridScore(
    query: IntentQuery,
    filePath: string,
    kgGraph: KGGraphLike,
    semanticScore?: number,
    _semanticSource?: 'embedding' | 'lexical'
  ): HybridScore {
    const intent = this.classifyIntent(query);
    const intentScore = this.intentScore(intent, filePath);

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

    const sem = semanticScore ?? 0.5;
    const total = this.weights.semantic * sem + this.weights.structural * structuralScore + this.weights.intent * intentScore;
    return {
      semantic: sem,
      structural: structuralScore,
      intent: intentScore,
      total: Math.min(1, Math.round(total * 100) / 100),
    };
  }

  // F4: fix KG adapter — findSimilarFiles returns FileInfo[] WITHOUT score; derive from rank
  deriveSemanticFromSimilar(queryEmb: number[], similarResults: Array<{ path: string; score?: number }>, _limit = 5): Array<{ path: string; score: number; source: 'embedding' | 'lexical' }> {
    const out: Array<{ path: string; score: number; source: 'embedding' | 'lexical' }> = [];
    for (let i = 0; i < similarResults.length; i++) {
      const rank = i + 1;
      const derived = Math.max(0, 1 - (rank - 1) * 0.15); // 1→1.0, 2→0.85, 3→0.7...
      out.push({ path: similarResults[i].path, score: derived, source: 'embedding' });
    }
    return out;
  }

  async search(query: IntentQuery, kgGraph?: KGGraphLike, limit = 10): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    const queryText = this.resolveQueryText(query);
    const intent = this.classifyIntent(query);

    // Semantic baseline using real embeddings
    let semanticFiles: Array<{ path: string; score: number; source: 'embedding' | 'lexical' }> = [];
    try {
      const queryEmb = await generateEmbedding(queryText, DEFAULT_DIMENSION);
      if (kgGraph && typeof kgGraph.findSimilarFiles === 'function') {
        const similar = kgGraph.findSimilarFiles(queryEmb, 0.5, limit);
        const derived = this.deriveSemanticFromSimilar(queryEmb, similar, limit);
        semanticFiles = derived;
      }
    } catch {
      // ignore
    }

    // Fallback: VecIndex
    if (semanticFiles.length === 0 && this.vecIndex?.isAvailable && this.vecIndex.isAvailable()) {
      try {
        const queryEmb = await generateEmbedding(queryText, DEFAULT_DIMENSION);
        const similar = this.vecIndex.findSimilar(queryEmb, limit);
        for (let i = 0; i < similar.length; i++) {
          const s = similar[i];
          let path = '';
          if (this.db) {
            const row = this.db.prepare('SELECT path FROM files WHERE id = ?').get(Number(s.id)) as { path?: string } | undefined;
            if (row?.path) path = row.path;
          }
          if (path) {
            const derived = Math.max(0, 1 - i * 0.15);
            semanticFiles.push({ path, score: derived, source: 'embedding' });
          }
        }
      } catch {
        // ignore
      }
    }

    // If still empty, try lexical fallback for query filePath
    if (semanticFiles.length === 0 && query.filePath) {
      try {
        const lexical = await this.computeSemanticScore(queryText, query.filePath);
        semanticFiles.push({ path: query.filePath, score: lexical.score, source: lexical.source });
      } catch {
        // ignore
      }
    }

    const seen = new Set<string>();
    for (const sf of semanticFiles) {
      if (seen.has(sf.path)) continue;
      seen.add(sf.path);
      const score = this.computeHybridScore(query, sf.path, kgGraph || { getFileByPath: () => null }, sf.score, sf.source);
      // F5: snippet = actual file content snippet (most relevant line window)
      let snippet = '';
      try {
        const resolved = this.resolveFilePath(sf.path);
        if (resolved) {
          const content = readFileSync(resolved, 'utf-8');
          const lines = content.split(/\r?\n/);
          // Pick a window around first marker match or first 3 lines
          const markerIdx = lines.findIndex(l => this.getMarkers(intent, l) > 0);
          const start = Math.max(0, (markerIdx >= 0 ? markerIdx : 0) - 1);
          snippet = lines.slice(start, start + 3).join('\n').substring(0, 200);
        }
      } catch {
        snippet = '';
      }
      results.push({
        filePath: sf.path,
        score,
        rank: 0,
        snippet: snippet || sf.path,
        source: sf.source,
      });
    }

    // Structural neighbors
    if (kgGraph && query.filePath) {
      try {
        const info = kgGraph.getFileByPath(query.filePath);
        if (info && typeof info.id === 'number') {
          const imports = kgGraph.getImports ? kgGraph.getImports(info.id) : [];
          const dependents = kgGraph.getDependents ? kgGraph.getDependents(info.id) : [];
          const seedPaths = new Set<string>();
          for (const imp of imports) if (imp.source) seedPaths.add(imp.source);
          for (const dep of dependents) if (dep.source) seedPaths.add(dep.source);
          // Relatedness: shared imports/dependents with seed files
          for (const seed of seedPaths) {
            if (!seen.has(seed)) {
              seen.add(seed);
              const score = this.computeHybridScore(query, seed, kgGraph, 0.4, 'embedding');
              let snippet = '';
              try {
                const resolved = this.resolveFilePath(seed);
                if (resolved) {
                  const content = readFileSync(resolved, 'utf-8');
                  snippet = content.split(/\r?\n/).slice(0, 3).join('\n').substring(0, 200);
                }
              } catch { snippet = seed; }
              results.push({ filePath: seed, score, rank: 0, snippet: snippet || seed, source: 'embedding' });
            }
          }
        }
      } catch {
        // ignore
      }
    }

    results.sort((a, b) => b.score.total - a.score.total);
    results.forEach((r, i) => (r.rank = i + 1));
    return results.slice(0, limit);
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
