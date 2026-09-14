import { reportSuppressedError } from '../../utils/errors.js';
import { DatabaseSync } from 'node:sqlite';
import { getDatabase } from '../../storage/database.js';
import { SCHEMA_SQL } from '../../storage/schema.js';
import { KnowledgeGraph } from '../../storage/knowledge-graph.js';
import { CoherenceEngine } from '../coherence/engine.js';
import { loadConfig } from '../../utils/config.js';
import { logger } from '../../utils/logger.js';
import { getParserDefinition } from '../../parser/parser-registry.js';
import type {
  RedundancyDetector,
  PatternDriftDetector,
  ArchitecturalDriftDetector,
  DebtPersistence,
  GenomeComputer,
} from './detection/interfaces.js';
import type { GenomeBreakdown } from './detection/genome.js';
import type { DebtItem, DebtReport } from './detection/persistence.js';
import { RedundancyDetector as RedundancyDetectorImpl } from './detection/redundancy.js';
import { PatternDriftDetector as PatternDriftDetectorImpl } from './detection/pattern-drift.js';
import { ArchitecturalDriftDetector as ArchitecturalDriftDetectorImpl } from './detection/architectural-drift.js';
import { DebtPersistence as DebtPersistenceImpl } from './detection/persistence.js';
import { GenomeComputer as GenomeComputerImpl } from './detection/genome.js';
import { collectGitChurn, type GitChurnEntry } from './git-churn.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CloneDetector } from '../dedup/clone-detector.js';
import { isTestPath } from '../../utils/test-detection.js';

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
    genomeComputer?: GenomeComputer,
  ) {
    this.db = db ?? getDatabase();
    this.db.exec(SCHEMA_SQL);
    this.kg = kg ?? new KnowledgeGraph();
    this.coherenceEngine = coherenceEngine ?? new CoherenceEngine();
    // Keep the constructor compatible with lightweight KnowledgeGraph test
    // doubles and older integrations while using the active project whenever
    // the full graph implementation is available.
    const projectId =
      typeof (this.kg as unknown as { getCurrentProjectId?: () => number }).getCurrentProjectId ===
      'function'
        ? (this.kg as unknown as { getCurrentProjectId: () => number }).getCurrentProjectId()
        : 1;
    this.persistence = persistence ?? new DebtPersistenceImpl(db, projectId);
    this.redundancyDetector = redundancyDetector ?? new RedundancyDetectorImpl(db);
    this.patternDriftDetector =
      patternDriftDetector ?? new PatternDriftDetectorImpl(this.coherenceEngine, this.persistence);
    this.architecturalDriftDetector =
      architecturalDriftDetector ?? new ArchitecturalDriftDetectorImpl(this.persistence);
    this.genomeComputer = genomeComputer ?? new GenomeComputerImpl(this.kg, db);
  }

  async detectDebt(): Promise<DebtItem[]> {
    const items: DebtItem[] = [];
    // Debt analysis is intentionally scoped to the supported JS/TS source
    // surface. Stale graph rows for retired languages must not re-enter the
    // report after a scan has narrowed the project to JavaScript/TypeScript.
    const files = this.kg.getAllFiles().filter((file) => getParserDefinition(file.relativePath));
    // MCP request-local scopes replace the graph façade's active project
    // without mutating the process-wide config. Prefer that scoped root so
    // clone detection and git churn never read a different project's disk.
    const projectRoot = this.kg.getCurrentProject()?.rootPath ?? loadConfig().projectRoot;
    // Detector output is a current snapshot. Remove unresolved findings for
    // every snapshot-based detector before writing fresh evidence; otherwise
    // a corrected run would continue displaying stale findings forever (for
    // example an old high-severity pattern row after its classification was
    // corrected to an advisory warning).
    for (const type of [
      'pattern_drift',
      'architectural_drift',
      'redundancy',
      'change_frequency',
    ] as const) {
      this.persistence.clearUnresolvedType(type);
    }

    // Batch read all file contents
    const fileContents = new Map<string, string>();
    // Bound concurrent filesystem reads; a repository with thousands of files
    // must not create one promise per file at once.
    const readBatchSize = 32;
    for (let i = 0; i < files.length; i += readBatchSize) {
      await Promise.all(
        files.slice(i, i + readBatchSize).map(async (file) => {
          try {
            const content = readFileSync(file.path, 'utf-8');
            fileContents.set(file.path, content);
          } catch (e) {
            logger.warn(`Failed to read file contents for debt analysis: ${file.path}`, {
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }),
      );
    }

    // Duplicate-code debt must be evidence-based. Embedding similarity is
    // useful for semantic navigation, but it cannot establish that two files
    // contain copied implementation: empty vectors, boilerplate signatures,
    // stale caches, and model changes all create false positives. The AST
    // clone detector compares function bodies after local-binding
    // normalization and reports source locations that can be reviewed.
    const cloneFiles = files
      .filter((file) => !isTestPath(file.relativePath))
      .map((file) => file.relativePath);
    const cloneResult = new CloneDetector(projectRoot).detect(cloneFiles, {
      minLines: 6,
      maxGroups: 50,
    });
    for (const group of cloneResult.groups) {
      const [first, ...copies] = group.occurrences;
      if (!first) continue;
      for (const copy of copies) {
        items.push(
          this.persistence.createDebtItem({
            type: 'redundancy',
            description:
              `Type-2 clone detected: ${first.filePath}:${first.startLine}-${first.endLine} ` +
              `(${first.name}) and ${copy.filePath}:${copy.startLine}-${copy.endLine} (${copy.name})`,
            severity: 'low',
            suggestion:
              'Review the matching function bodies and extract shared logic if appropriate',
            reasoningTrace: [
              `AST body fingerprints match after local-binding normalization (${group.fingerprint})`,
              `Clone detector scanned ${cloneResult.scannedFunctions} function-like units`,
            ],
            filePath: resolve(projectRoot, copy.filePath),
          }),
        );
      }
    }

    // Change-frequency signal from git history — collected ONCE per run and
    // shared across all per-file checks. collectGitChurn never throws (not a
    // repo / git missing → empty map); the extra guard keeps debt detection
    // degrading gracefully even if that contract ever changes.
    let churn = new Map<string, GitChurnEntry>();
    try {
      churn = collectGitChurn(projectRoot, CHANGE_FREQUENCY_WINDOW_DAYS);
    } catch (error) {
      reportSuppressedError(error, 'Intentional fallback src/core/debt/tracker-core.ts:155');
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

        const churnEntry = churn.get(file.relativePath.replace(/\\/g, '/'));
        if (churnEntry && churnEntry.count >= HIGH_CHURN_THRESHOLD) {
          items.push(
            this.persistence.createDebtItem({
              type: 'change_frequency',
              description: `High change frequency in ${file.relativePath} (${churnEntry.count} commits in ${CHANGE_FREQUENCY_WINDOW_DAYS} days)`,
              // Churn is historical context, not a defect in itself. Keep it
              // visible as low-severity advisory debt rather than blocking
              // production readiness as a medium finding.
              severity: 'low',
              suggestion: 'Review recently changed code for regression risk and missing safeguards',
              reasoningTrace: [
                `Git history recorded ${churnEntry.count} changes by ${churnEntry.authors.size} author(s)`,
              ],
              filePath: file.path,
            }),
          );
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

  resolveDebt(debtId: number): boolean {
    return this.persistence.resolveDebt(debtId);
  }

  computeGenome(): { genomeData: string; coherenceScore: number; breakdown: GenomeBreakdown } {
    return this.genomeComputer.compute();
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
