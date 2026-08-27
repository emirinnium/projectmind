import { DatabaseSync } from 'node:sqlite';
import { getDatabase } from '../../storage/database.js';
import { SCHEMA_SQL } from '../../storage/schema.js';
import { KnowledgeGraph } from '../../storage/knowledge-graph.js';
import { CoherenceEngine } from '../coherence/engine.js';
import { readFileSync } from 'node:fs';
import { logger } from '../../utils/logger.js';
import { RedundancyDetector } from './detection/redundancy.js';
import { PatternDriftDetector } from './detection/pattern-drift.js';
import { ArchitecturalDriftDetector } from './detection/architectural-drift.js';
import { DebtPersistence } from './detection/persistence.js';
import { GenomeComputer } from './detection/genome.js';
import type { DebtItem, DebtReport } from './detection/persistence.js';

export type { DebtItem, DebtReport, DebtType, Severity } from './detection/persistence.js';

/**
 * Core DebtTracker class - orchestrates debt detection and management
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

  constructor(db?: DatabaseSync, kg?: KnowledgeGraph, engine?: CoherenceEngine) {
    this.db = db ?? getDatabase();
    this.db.exec(SCHEMA_SQL);
    this.kg = kg ?? new KnowledgeGraph();
    this.coherenceEngine = engine ?? new CoherenceEngine();
    this.redundancyDetector = new RedundancyDetector(db);
    this.persistence = new DebtPersistence(db);
    this.patternDriftDetector = new PatternDriftDetector(this.coherenceEngine, this.persistence);
    this.architecturalDriftDetector = new ArchitecturalDriftDetector(this.persistence);
    this.genomeComputer = new GenomeComputer(this.kg, db);
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
        logger.debug(`Skipping file in debt detection: ${file.relativePath} - ${e instanceof Error ? e.message : String(e)}`);
      }
    });
    await Promise.all(readPromises);

    // Process files in batches to avoid memory issues
    const batchSize = 20;
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);
      
      // Process each file in the batch
      for (const file of batch) {
        const content = fileContents.get(file.path);
        if (!content) continue;

        // Technical Debt Analysis
        const technicalDebt = this.analyzeTechnicalDebt(file, content);
        items.push(...technicalDebt);

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

  computeGenome(): { genomeData: string; coherenceScore: number } {
    return this.genomeComputer.compute();
  }

  /**
   * Analyze technical debt metrics for a file.
   */
  private analyzeTechnicalDebt(file: { path: string; relativePath: string; lastModified?: string; cognitiveLoad?: number }, content: string): DebtItem[] {
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

    // 3. Cognitive Load Analysis
    if (file.cognitiveLoad && file.cognitiveLoad > 50) {
      reasoningTrace.push(`High cognitive load detected (${file.cognitiveLoad})`);
      items.push(this.persistence.createDebtItem({
        type: 'cognitive_load',
        description: `High cognitive load in ${file.relativePath} (${file.cognitiveLoad})`,
        severity: 'high',
        suggestion: `Split file into smaller modules or simplify logic`,
        reasoningTrace,
        filePath: file.path,
      }));
    }

    // 4. Change Frequency Analysis (placeholder - requires git integration)
    // This would require git history analysis, which is out of scope for now
    // but can be added later.

    return items;
  }

  getCacheStats() {
    return this.redundancyDetector['embeddingCache']?.getStats?.() ?? {};
  }

  clearAllDebt(): void {
    this.persistence.clearAll();
  }

  clearPatterns(): void {
    this.persistence.clearPatterns();
  }
}