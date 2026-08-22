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
    this.redundancyDetector = new RedundancyDetector();
    this.patternDriftDetector = new PatternDriftDetector(this.coherenceEngine);
    this.architecturalDriftDetector = new ArchitecturalDriftDetector();
    this.persistence = new DebtPersistence();
    this.genomeComputer = new GenomeComputer(this.kg);
  }

  async detectDebt(): Promise<DebtItem[]> {
    const items: DebtItem[] = [];
    const files = this.kg.getAllFiles();

    // Batch-fetch all file embeddings in a single query to avoid N+1
    const embeddings = this.redundancyDetector.getFileEmbeddings(files.map((f: { id: number }) => f.id));

    for (const file of files) {
      try {
        const content = readFileSync(file.path, 'utf-8');

        // Reuse stored embedding from the batch fetch instead of recomputing
        const targetEmbedding = embeddings.get(file.id);
        if (targetEmbedding) {
          const similarFiles = this.redundancyDetector.findSimilarFiles(file, targetEmbedding, files, embeddings);
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

      } catch (e) {
        // Skip files that can't be read
        logger.debug(`Skipping file in debt detection: ${file.relativePath} - ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const driftDebts = await this.architecturalDriftDetector.detect(files);
    items.push(...driftDebts);

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