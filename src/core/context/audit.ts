import type { DatabaseSync } from 'node:sqlite';
import type { KnowledgeGraph } from '@/storage/knowledge-graph.js';
import { AgentReplayStore } from '@/core/replay/agent-replay.js';
import { EvidenceLedger, computeIndexedGraphHash } from '@/core/ledger/evidence-ledger.js';
import { logger } from '@/utils/logger.js';

export interface ContextDecisionAuditInput {
  filePath: string;
  task?: string;
  imports: number;
  resolvedImports: number;
  dependents: number;
  similarFiles: number;
  evidenceStatus: string;
  evidenceFiles: number;
  selectedPaths: readonly string[];
  sourceHashes: Readonly<Record<string, string | undefined>>;
}

export interface ContextDecisionAuditReceipt {
  ledgerRecordId: number;
  ledgerRecordHash: string;
  replayEventId: number;
  replayEventHash: string;
}

/** Persist context-selection metadata without storing source or prompt text. */
export function recordContextDecision(
  db: DatabaseSync | undefined,
  kg: Pick<KnowledgeGraph, 'getCurrentProjectId' | 'getAllFiles'>,
  input: ContextDecisionAuditInput,
): ContextDecisionAuditReceipt | undefined {
  if (!db) return undefined;

  try {
    const projectId = kg.getCurrentProjectId();
    const graphHash = computeIndexedGraphHash(kg);
    const result = {
      filePath: input.filePath,
      ...(input.task ? { taskProvided: true } : { taskProvided: false }),
      imports: input.imports,
      resolvedImports: input.resolvedImports,
      dependents: input.dependents,
      similarFiles: input.similarFiles,
      evidenceStatus: input.evidenceStatus,
      evidenceFiles: input.evidenceFiles,
      selectedFileCount: input.selectedPaths.length,
      selectedPaths: JSON.stringify(
        [...new Set(input.selectedPaths.map((path) => path.replace(/\\/g, '/')))].sort(),
      ),
      selectedSourceHashes: JSON.stringify(
        Object.fromEntries(
          Object.entries(input.sourceHashes)
            .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
            .sort(([left], [right]) => left.localeCompare(right)),
        ),
      ),
    };
    const ledgerRecord = new EvidenceLedger(db, projectId).append({
      eventType: 'context',
      toolName: 'get_context',
      input: {
        filePath: input.filePath,
        taskProvided: !!input.task,
        taskLength: input.task?.length ?? 0,
      },
      result,
      graphHash,
      scope: `project:${projectId}:${input.filePath}`,
      sourceFreshness:
        input.evidenceStatus === 'verified'
          ? 'fresh'
          : input.evidenceStatus === 'stale'
            ? 'stale'
            : input.evidenceStatus === 'partial'
              ? 'unindexed'
              : 'unknown',
      summary: {
        imports: input.imports,
        dependents: input.dependents,
        similarFiles: input.similarFiles,
        evidenceStatus: input.evidenceStatus,
      },
    });
    const replayEvent = new AgentReplayStore(db, projectId).append({
      eventType: 'context',
      toolName: 'get_context',
      filePath: input.filePath,
      graphHash,
      outcome: result,
    });
    return {
      ledgerRecordId: ledgerRecord.id,
      ledgerRecordHash: ledgerRecord.recordHash,
      replayEventId: replayEvent.id,
      replayEventHash: replayEvent.eventHash,
    };
  } catch (error) {
    logger.warn('Context decision audit could not be persisted; context remains available.', {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
