import { DatabaseSync } from 'node:sqlite';
import { getDatabase } from '../../storage/database.js';
import { SCHEMA_SQL } from '../../storage/schema.js';
import { KnowledgeGraph } from '../../storage/knowledge-graph.js';
import { CoherenceEngine } from '../coherence/engine.js';
import { loadConfig } from '../../utils/config.js';
import { logger } from '../../utils/logger.js';
import type { RedundancyDetector } from './detection/interfaces.js';
import type { PatternDriftDetector } from './detection/interfaces.js';
import type { ArchitecturalDriftDetector } from './detection/interfaces.js';
import type { DebtPersistence } from './detection/interfaces.js';
import type { GenomeComputer } from './detection/interfaces.js';
import type { GenomeBreakdown } from './detection/genome.js';
import type { DebtItem, DebtReport } from './detection/persistence.js';
import { RedundancyDetector as RedundancyDetectorImpl } from './detection/redundancy.js';
import { PatternDriftDetector as PatternDriftDetectorImpl } from './detection/pattern-drift.js';
import { ArchitecturalDriftDetector as ArchitecturalDriftDetectorImpl } from './detection/architectural-drift.js';
import { DebtPersistence as DebtPersistenceImpl } from './detection/persistence.js';
import { GenomeComputer as GenomeComputerImpl } from './detection/genome.js';
import { collectGitChurn, type GitChurnEntry } from './git-churn.js';
import { COGNITIVE_LOAD_THRESHOLD } from './index.js';
import { readFileSync } from 'node:fs';
import type { FileInfo } from '../../storage/knowledge-graph.js';

/** Window (in days) for the git change-frequency analysis. */
const CHANGE_FREQUENCY_WINDOW_DAYS = 30;
/** Commits within the window at/above which a file is flagged as high-churn. */
const HIGH_CHURN_THRESHOLD = 10;

/**
 * Core DebtTracker class - orchestrates debt detection and management
 * Dependencies are injected via constructor interfaces for loose coupling.
 */
export class DebtTracker {
  private db: DatabaseSync;
  private kg: KnowledgeGraph;
  private coherenceEngine: CoherenceEngine;
  private redundancyDetector: RedundancyDetector;
  private patternDriftDetector: PatternDriftDetector;
  private architecturalDriftDetector: ArchitecturalDriftDetector;
  private persistence: DebtPersistence;
  private genomeComputer: GenomeComputer;

    constructor(
      db?: DatabaseSync,
      kg?: KnowledgeGraph,
      coherenceEngine?: CoherenceEngine,
      redundancyDetector?: RedundancyDetector,
      patternDriftDetector?: PatternDriftDetector,
      architecturalDriftDetector?: ArchitecturalDriftDetector,
      persistence?: DebtPersistence,
      genomeComputer?: GenomeComputer
    ) {
      this.db = db ?? getDatabase();
      this.db.exec(SCHEMA_SQL);
      this.kg = kg ?? new KnowledgeGraph();
      this.coherenceEngine = coherenceEngine ?? new CoherenceEngine();
      this.persistence = persistence ?? new DebtPersistenceImpl(db);
      this.redundancyDetector = redundancyDetector ?? new RedundancyDetectorImpl(db);
      this.patternDriftDetector = patternDriftDetector ?? new PatternDriftDetectorImpl(this.coherenceEngine, this.persistence);
      this.architecturalDriftDetector = architecturalDriftDetector ?? new ArchitecturalDriftDetectorImpl(this.persistence);
      this.genomeComputer = genomeComputer ?? new GenomeComputerImpl(this.kg, db);
    }

  async detectDebt(): Promise<DebtItem[]> {
    const items: DebtItem[] = [];
    const files = this.kg.getAllFiles();

    // Batch-fetch all file embeddings in a single query to avoid N+1
    const embeddings = this.redundancyDetector.getFileEmbeddings(files.map((f: { id: number }) => f.id));
    
    // Batch read all file contents
    const fileContents = new Map<string, string>();
    const readPromises = files.map(async (file) => {
      try {
        const content = readFileSync(file.path, 'utf-8');
        fileContents.set(file.path, content);
      } catch (e) {
        logger.warn(`Failed to read file contents for debt analysis: ${file.path}`, {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    });
    await Promise.all(readPromises);

    // Change-frequency signal from git history — collected ONCE per run and
    // shared across all per-file checks. collectGitChurn never throws (not a
    // repo / git missing → empty map); the extra guard keeps debt detection
    // degrading gracefully even if that contract ever changes.
    let churn = new Map<string, GitChurnEntry>();
    try {
      churn = collectGitChurn(loadConfig().projectRoot, CHANGE_FREQUENCY_WINDOW_DAYS);
    } catch (e) {
      // skip change-frequency analysis gracefully
    }

    // Process files in batches to avoid memory issues
    const batchSize = 20;
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);
      
      // Process each file in the batch
      for (const file of batch) {
        const content = fileContents.get(file.path);
        if (!content) continue;

        // Reuse stored embedding from the batch fetch instead of recomputing
        const targetEmbedding = embeddings.get(file.id);
        if (targetEmbedding) {
          const similarFiles = await this.redundancyDetector.findSimilarFiles(file, targetEmbedding, files, embeddings);
          for (const similar of similarFiles) {
            items.push(this.persistence.createDebtItem({
              type: 'redundancy',
              description: `Potential duplicate code: ${file.relativePath} vs ${similar.relativePath}`,
              severity: 'low',
              suggestion: `Consider extracting shared logic into a common module`,
              reasoningTrace: [
                `Semantic similarity detected between ${file.relativePath} and ${similar.relativePath}`,
                `Consider refactoring to reduce code duplication`,
              ],
              filePath: file.path,
            }));
          }
        }

        const debtItems = await this.patternDriftDetector.detect(file, content);
        items.push(...debtItems);
      }
    }

    const driftDebts = await this.architecturalDriftDetector.detect(files);
    items.push(...driftDebts);

    // Batch insert all debt items
    if (items.length > 0) {
      this.persistence.batchInsertDebtItems(items);
    }

    return items;
  }

  getReport(): DebtReport {
    return this.persistence.getReport();
  }

  resolveDebt(debtId: number): void {
    this.persistence.resolveDebt(debtId);
  }

  computeGenome(): { genomeData: string; coherenceScore: number; breakdown: GenomeBreakdown } {
    return this.genomeComputer.compute();
  }

  /**
   * Analyze technical debt metrics for a file.
   */
  private analyzeTechnicalDebt(
    file: { path: string; relativePath: string; lastModified?: string; cognitiveLoad?: number },
    content: string,
    churn: Map<string, GitChurnEntry> = new Map()
  ): DebtItem[] {
    const items: DebtItem[] = [];
    const reasoningTrace: string[] = [];

    // 1. Complexity Analysis — count decision points inside function bodies.
    //    Two shapes are covered: `function name(...) { ... }` declarations and
    //    `name = (args) => { ... }` / `name = arg => { ... }` arrow assignments.
    //    Robust by construction: arrow matches have no `function` substring
    //    (previously `match.split('function')[1]` crashed with undefined.split)
    //    and the regex is a literal — template-literal escape corruption
    //    (`\s` cooked to `s` in backtick strings) can't occur.
    const complexFunctionNames: string[] = [];
    const funcBodyRe =
      /(?:function\s+([A-Za-z0-9_$]+)\s*\([^)]*\)\s*\{|([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z0-9_$]+)\s*=>\s*\{)([\s\S]*?)\n\}/g;
    let bodyMatch: RegExpExecArray | null;
    while ((bodyMatch = funcBodyRe.exec(content)) !== null) {
      const body = bodyMatch[3] ?? '';
      const decisionPoints =
        (body.match(/\b(?:if|for|while|case|catch)\b/g) ?? []).length +
        (body.match(/\?|\&\&|\|\|/g) ?? []).length;
      if (decisionPoints > 10) {
        complexFunctionNames.push(bodyMatch[1] ?? bodyMatch[2] ?? 'anonymous');
      }
    }

    if (complexFunctionNames.length > 0) {
      reasoningTrace.push(`High cyclomatic complexity detected in ${complexFunctionNames.length} functions`);
      items.push(this.persistence.createDebtItem({
        type: 'complexity',
        description: `High cyclomatic complexity in ${file.relativePath}`,
        severity: 'medium',
        suggestion: `Refactor complex functions into smaller, more manageable pieces`,
        reasoningTrace,
        filePath: file.path,
      }));
    }

    // 2. Code Age Analysis
    if (file.lastModified) {
      const lastModified = new Date(file.lastModified).getTime();
      const now = Date.now();
      const ageInDays = (now - lastModified) / (1000 * 60 * 60 * 24);
      
      if (ageInDays > 365) {
        reasoningTrace.push(`File is ${Math.floor(ageInDays)} days old - potential legacy code`);
        items.push(this.persistence.createDebtItem({
          type: 'code_age',
          description: `Legacy code detected in ${file.relativePath} (${Math.floor(ageInDays)} days old)`,
          severity: 'low',
          suggestion: `Review for outdated patterns or dependencies`,
          reasoningTrace,
          filePath: file.path,
        }));
      }
    }

    // 3. Cognitive Load Analysis — tiered scheme (consistent with architecture.ts)
    if (file.cognitiveLoad) {
      if (file.cognitiveLoad > COGNITIVE_LOAD_THRESHOLD) {
        reasoningTrace.push(`High cognitive load detected (${file.cognitiveLoad})`);
        items.push(this.persistence.createDebtItem({
          type: 'cognitive_load',
          description: `High cognitive load in ${file.relativePath} (${file.cognitiveLoad})`,
          severity: 'high',
          suggestion: `Split file into smaller modules or simplify logic`,
          reasoningTrace,
          filePath: file.path,
        }));
      } else if (file.cognitiveLoad > 0.4) {
        reasoningTrace.push(`Moderate cognitive load detected (${file.cognitiveLoad})`);
        items.push(this.persistence.createDebtItem({
          type: 'cognitive_load',
          description: `Moderate cognitive load in ${file.relativePath} (${file.cognitiveLoad})`,
          severity: 'medium',
          suggestion: `Consider refactoring to reduce complexity in ${file.relativePath}`,
          reasoningTrace,
          filePath: file.path,
        }));
      }
    }

    // 4. Change Frequency Analysis — real git history (collected once per
    //    detectDebt run). Files that change often attract regressions; when
    //    git is unavailable the churn map is empty and this check is skipped.
    const churnEntry = churn.get(file.relativePath.replace(/\\/g, '/'));
    if (churnEntry && churnEntry.count >= HIGH_CHURN_THRESHOLD) {
      reasoningTrace.push(
        `File changed ${churnEntry.count} times in the last ${CHANGE_FREQUENCY_WINDOW_DAYS} days by ${churnEntry.authors.size} author(s)`
      );
      items.push(this.persistence.createDebtItem({
        type: 'change_frequency',
        description: `High change frequency in ${file.relativePath} (${churnEntry.count} commits in ${CHANGE_FREQUENCY_WINDOW_DAYS} days)`,
        severity: 'medium',
        suggestion: `Frequently changed files attract regressions — consider strengthening test coverage or stabilizing the interface`,
        reasoningTrace,
        filePath: file.path,
      }));
    }

    return items;
  }

  getCacheStats() {
    return this.redundancyDetector.getCacheStats();
  }

  clearAllDebt(): void {
    this.persistence.clearAll();
  }

  clearPatterns(): void {
    this.persistence.clearPatterns();
  }
}