import { reportSuppressedError } from '../../../utils/errors.js';
import { DatabaseSync } from 'node:sqlite';
import { getDatabase } from '../../../storage/database.js';
import { KnowledgeGraph } from '../../../storage/knowledge-graph.js';
import { PatternLibrary, Pattern } from '../../../parser/pattern-extractor.js';
import { stableHash } from '../../../utils/hash.js';
import { readFileSync } from 'node:fs';
import { getDefaultAliasResolver } from '../../../parser/alias-resolver.js';

export interface GenomeResult {
  genomeData: string;
  coherenceScore: number;
  breakdown: GenomeBreakdown;
}

export interface GenomeBreakdown {
  avgConfidence: number;
  weightedConfidence: number;
  violationPenalty: number;
  patternCount: number;
  highConfidencePatterns: number;
  agentSessions: number;
  importResolutionRate: number;
  circularDepPenalty: number;
  markerCount: number;
}

/**
 * Computes the project coherence genome score
 */
export class GenomeComputer {
  private kg: KnowledgeGraph;
  private db: DatabaseSync;

  constructor(kg: KnowledgeGraph, db?: DatabaseSync) {
    this.kg = kg;
    this.db = db || getDatabase();
  }

  private getStmt(sql: string) {
    return this.db.prepare(sql);
  }

  compute(): GenomeResult {
    // Cache pattern library results for 30 seconds to avoid repeated full scans
    if (!this.patternCache || Date.now() > this.patternCacheExpiry) {
      const patterns = new PatternLibrary(this.db);
      this.patternCache = patterns.getPatterns();
      this.patternCacheExpiry = Date.now() + 30_000;
    }
    const projectPatterns = this.patternCache ?? [];

    const violations = this.getStmt(
      "SELECT COUNT(*) as cnt FROM debt_items WHERE resolved = 0 AND severity = 'high'",
    ).get() as { cnt: number };

    const violationCount = violations?.cnt ?? 0;

    // Calculate weighted confidence by usage count (more used = more reliable)
    let totalWeight = 0;
    let weightedSum = 0;
    let highConfidenceCount = 0;

    for (const p of projectPatterns) {
      const weight = Math.max(1, p.usageCount);
      weightedSum += p.confidence * weight;
      totalWeight += weight;
      if (p.confidence >= 0.8) highConfidenceCount++;
    }

    const avgConfidence =
      projectPatterns.reduce((s: number, p: Pattern) => s + p.confidence, 0) /
      Math.max(projectPatterns.length, 1);
    const weightedConfidence = totalWeight > 0 ? weightedSum / totalWeight : avgConfidence;

    const violationPenalty = Math.min(violationCount * 0.02, 0.3);

    // Import resolution bonus (0-5%) - check if imports table has resolved column
    let importResolutionRate = 0;
    let importBonus = 0;
    try {
      const importRows = this.getStmt(
        'SELECT i.source, i.resolved FROM imports i JOIN files f ON f.id = i.file_id WHERE f.project_id = ?',
      ).all(this.kg.getCurrentProjectId()) as Array<{ source: string; resolved: number }>;
      const aliasResolver = getDefaultAliasResolver();
      const localImports = importRows.filter((row) =>
        aliasResolver.isProjectLocalSource(row.source),
      );
      const resolvedLocalImports = localImports.filter((row) => row.resolved === 1).length;
      importResolutionRate =
        localImports.length > 0 ? resolvedLocalImports / localImports.length : 1;
      importBonus = importResolutionRate * 0.05;
    } catch {
      // Column doesn't exist, skip import bonus
      importResolutionRate = 0;
      importBonus = 0;
    }

    // Circular dependency penalty. The persisted table is historical output
    // and can contain cycles that disappeared after a later scan. Prefer the
    // live graph result so stale rows cannot lower the current score.
    let circularDepCount = 0;
    let circularDepPenalty = 0;
    try {
      const graphWithCycles = this.kg as unknown as {
        findCircularDependencies?: () => string[][];
      };
      if (typeof graphWithCycles.findCircularDependencies === 'function') {
        circularDepCount = graphWithCycles.findCircularDependencies().length;
      }
      // There is intentionally no persisted-table fallback. That table is a
      // historical record and can retain cycles that disappeared after a
      // later scan; applying its count would fabricate a penalty. Older or
      // minimal graph implementations without a live cycle method therefore
      // contribute no penalty until they can provide fresh evidence.
      circularDepPenalty = Math.min(circularDepCount * 0.05, 0.2);
    } catch {
      // A cycle scan failure must not fabricate a penalty into the score.
      circularDepCount = 0;
      circularDepPenalty = 0;
    }

    // Marker count from TODO/FIXME scanning across all project files.
    // Marker count is recorded in the genome breakdown but does not penalty
    // the coherence score (unlike violation/circular dep penalties).
    let markerCount = 0;
    try {
      const allFiles = this.kg.getAllFiles();
      let totalMarkers = 0;
      for (const file of allFiles) {
        try {
          const content = readFileSync(file.path, 'utf-8');
          const lines = content.split(/\r?\n/);
          for (const line of lines) {
            const match = line.match(/\b(TODO|FIXME)\b[:\s]+(.*)/);
            if (match) {
              totalMarkers++;
            }
          }
        } catch (error) {
          reportSuppressedError(
            error,
            'Intentional fallback src/core/debt/detection/genome.ts:139',
          );
          // Skip files that can't be read
        }
      }
      markerCount = totalMarkers;
    } catch {
      markerCount = 0;
    }

    // Agent coverage bonus (0-5%)
    const agentSessions = this.kg.getAgentSessions().length;
    const agentCoverage = Math.min(agentSessions / 10, 1); // Max bonus at 10 sessions
    const agentBonus = agentCoverage * 0.05;

    const coherenceScore = Math.max(
      0,
      Math.min(
        1,
        weightedConfidence * 0.7 +
          avgConfidence * 0.3 -
          violationPenalty -
          circularDepPenalty +
          importBonus +
          agentBonus,
      ),
    );

    const breakdown: GenomeBreakdown = {
      avgConfidence: Math.round(avgConfidence * 1000) / 1000,
      weightedConfidence: Math.round(weightedConfidence * 1000) / 1000,
      violationPenalty: Math.round(violationPenalty * 1000) / 1000,
      patternCount: projectPatterns.length,
      highConfidencePatterns: highConfidenceCount,
      agentSessions,
      importResolutionRate: Math.round(importResolutionRate * 1000) / 1000,
      circularDepPenalty: Math.round(circularDepPenalty * 1000) / 1000,
      markerCount,
    };

    const genomeData = JSON.stringify({
      patternCount: projectPatterns.length,
      violationCount,
      agentSessions,
      markerCount,
      coherenceScore,
      breakdown,
      computedAt: new Date().toISOString(),
    });

    const checksum = this.hashCode(genomeData);
    this.getStmt(
      `INSERT OR REPLACE INTO project_genome (checksum, genome_data, coherence_score, computed_at) 
     VALUES (?, ?, ?, ?)`,
    ).run(checksum, genomeData, coherenceScore, new Date().toISOString());

    // Prune history: keep only the 10 most recent genome snapshots so the
    // table cannot grow unboundedly across a long-lived server.
    this.getStmt(
      `DELETE FROM project_genome WHERE id NOT IN (
       SELECT id FROM project_genome ORDER BY computed_at DESC, id DESC LIMIT 10
     )`,
    ).run();

    return { genomeData, coherenceScore, breakdown };
  }

  private patternCache: Pattern[] | null = null;
  private patternCacheExpiry = 0;

  /** Kept as thin alias — single crypto-backed implementation in utils/hash. */
  private hashCode(str: string): string {
    return stableHash(str);
  }
}
