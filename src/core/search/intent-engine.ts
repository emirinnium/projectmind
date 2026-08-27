import type { IntentQuery, IntentType, HybridScore, SearchResult } from './types.js';

export interface KGGraphLike {
  getFileByPath(path: string): { id?: number; path: string } | null;
  getImports?(fileId: number): Array<{ source: string; named: string[]; kind: string }>;
  findSimilarFiles?(embedding: number[], threshold?: number, limit?: number): Array<{ path: string; score: number }>;
}

export class IntentEngine {
  private readonly intentKeywords: Record<IntentType, string[]> = {
    read: ['read', 'find', 'search', 'locate', 'discover', 'view', 'show', 'get', 'fetch'],
    write: ['write', 'create', 'add', 'insert', 'modify', 'update', 'edit', 'generate', 'produce'],
    validate: ['validate', 'check', 'verify', 'test', 'lint', 'audit', 'inspect', 'ensure', 'confirm'],
    transform: ['transform', 'convert', 'refactor', 'rewrite', 'migrate', 'change', 'adapt', 'restructure'],
  };

  private readonly astPatterns: Record<IntentType, string[]> = {
    read: ['import', 'require', 'from', 'export', 'function', 'class', 'interface'],
    write: ['function', 'class', 'const', 'let', 'var', 'export', 'return'],
    validate: ['assert', 'expect', 'test', 'describe', 'it', 'check', 'verify'],
    transform: ['refactor', 'rename', 'replace', 'map', 'filter', 'reduce', 'convert'],
  };

  classifyIntent(query: IntentQuery): IntentType {
    const text = (query.text + ' ' + (query.context || '')).toLowerCase();
    const scores: Record<IntentType, number> = {
      read: 0,
      write: 0,
      validate: 0,
      transform: 0,
    };

    for (const [intent, keywords] of Object.entries(this.intentKeywords)) {
      for (const kw of keywords) {
        if (text.includes(kw)) scores[intent as IntentType] += 1;
      }
    }

    // AST pattern boost (zero-shot via query content heuristics)
    for (const [intent, patterns] of Object.entries(this.astPatterns)) {
      for (const pat of patterns) {
        if (text.includes(pat)) scores[intent as IntentType] += 0.5;
      }
    }

    // File path context boost
    if (query.filePath) {
      const pathLower = query.filePath.toLowerCase();
      if (pathLower.includes('.test.') || pathLower.includes('.spec.')) {
        scores.validate += 1.5;
      }
      if (pathLower.includes('refactor') || pathLower.includes('migrate')) {
        scores.transform += 1.5;
      }
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

  computeHybridScore(
    query: IntentQuery,
    filePath: string,
    kgGraph: KGGraphLike,
    semanticScore?: number
  ): HybridScore {
    const intentScore = this.intentScore(this.classifyIntent(query), query);

    // Structural: count KG connections for file
    let structuralScore = 0.3;
    try {
      const fileInfo = kgGraph.getFileByPath(filePath);
      if (fileInfo && typeof fileInfo.id === 'number' && kgGraph.getImports) {
        const imports = kgGraph.getImports(fileInfo.id);
        structuralScore = Math.min(1, 0.3 + imports.length * 0.15);
      } else if (fileInfo) {
        structuralScore = 0.5;
      }
    } catch {
      structuralScore = 0.3;
    }

    const sem = semanticScore ?? 0.5;
    const total = 0.4 * sem + 0.3 * structuralScore + 0.3 * intentScore;

    return {
      semantic: sem,
      structural: structuralScore,
      intent: intentScore,
      total: Math.min(1, total),
    };
  }

  private intentScore(intent: IntentType, query: IntentQuery): number {
    const text = (query.text + ' ' + (query.context || '')).toLowerCase();
    const keywords = this.intentKeywords[intent];
    let score = 0.5;
    for (const kw of keywords) {
      if (text.includes(kw)) score += 0.1;
    }
    return Math.min(1, score);
  }

  async search(query: IntentQuery, kgGraph?: KGGraphLike, limit = 10): Promise<SearchResult[]> {
    const intent = this.classifyIntent(query);
    const results: SearchResult[] = [];

    // Semantic baseline (file-level, not line-level)
    let semanticFiles: Array<{ path: string; score: number }> = [];
    if (kgGraph && typeof kgGraph.findSimilarFiles === 'function') {
      try {
        // We assume embedding is handled externally; here we use a placeholder
        // In real usage, query embedding is generated and passed
        semanticFiles = [];
      } catch {
        // ignore
      }
    }

    // If no semantic files from KG, fall back to structural scan via filePath
    if (semanticFiles.length === 0 && query.filePath && kgGraph) {
      const info = kgGraph.getFileByPath(query.filePath);
      if (info) {
        semanticFiles.push({ path: info.path || query.filePath, score: 0.7 });
      }
    }

    // Build results with hybrid scoring
    const seen = new Set<string>();
    for (const sf of semanticFiles) {
      if (seen.has(sf.path)) continue;
      seen.add(sf.path);
      const score = this.computeHybridScore(query, sf.path, kgGraph || { getFileByPath: () => null }, sf.score);
      results.push({
        filePath: sf.path,
        score,
        rank: 0,
        snippet: query.text.substring(0, 120),
      });
    }

    // Add structural neighbors if KG available
    if (kgGraph && query.filePath) {
      try {
        const info = kgGraph.getFileByPath(query.filePath);
        if (info && typeof info.id === 'number' && kgGraph.getImports) {
          const imports = kgGraph.getImports(info.id);
          for (const imp of imports) {
            if (imp.source && !seen.has(imp.source)) {
              seen.add(imp.source);
              const score = this.computeHybridScore(query, imp.source, kgGraph, 0.4);
              results.push({
                filePath: imp.source,
                score,
                rank: 0,
                snippet: `import from ${imp.source}`,
              });
            }
          }
        }
      } catch {
        // ignore structural errors
      }
    }

    results.sort((a, b) => b.score.total - a.score.total);
    results.forEach((r, i) => (r.rank = i + 1));
    return results.slice(0, limit);
  }
}
