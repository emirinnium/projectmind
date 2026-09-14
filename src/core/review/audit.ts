import type { DatabaseSync } from 'node:sqlite';
import type { KnowledgeGraph } from '@/storage/knowledge-graph.js';
import { AgentReplayStore } from '@/core/replay/agent-replay.js';
import { EvidenceLedger, computeIndexedGraphHash } from '@/core/ledger/evidence-ledger.js';
import { logger } from '@/utils/logger.js';

export interface ReviewDecisionAuditInput {
  base: string;
  head: string;
  policyVersion: string;
  changedFiles: readonly string[];
  excludedFiles: number;
  generatedFindings: number;
  verifiedFindings: number;
  complete: boolean;
  coherenceRisk?: 'low' | 'medium' | 'high';
}

export interface ReviewDecisionAuditReceipt {
  ledgerRecordId: number;
  ledgerRecordHash: string;
  replayEventId: number;
  replayEventHash: string;
}

/**
 * Persist a payload-free review decision in both audit chains.
 *
 * Review output remains source-backed and deterministic; only hashes and
 * scalar counts are persisted. Audit failure is deliberately best-effort so a
 * read/review operation is never reported as failed solely because an older
 * database cannot accept the new metadata table.
 */
export function recordReviewDecision(
  db: DatabaseSync | undefined,
  kg: Pick<KnowledgeGraph, 'getCurrentProjectId' | 'getAllFiles'>,
  input: ReviewDecisionAuditInput,
): ReviewDecisionAuditReceipt | undefined {
  if (!db) return undefined;

  try {
    const projectId = kg.getCurrentProjectId();
    const graphHash = computeIndexedGraphHash(kg);
    const result = {
      changedFiles: input.changedFiles.length,
      excludedFiles: input.excludedFiles,
      generatedFindings: input.generatedFindings,
      verifiedFindings: input.verifiedFindings,
      complete: input.complete,
      ...(input.coherenceRisk ? { coherenceRisk: input.coherenceRisk } : {}),
    };
    const ledgerRecord = new EvidenceLedger(db, projectId).append({
      eventType: 'review',
      toolName: 'review_project',
      input: {
        base: input.base,
        head: input.head,
        policyVersion: input.policyVersion,
        changedFiles: [...input.changedFiles],
      },
      result,
      graphHash,
      policyVersion: input.policyVersion,
      summary: result,
    });
    const replayEvent = new AgentReplayStore(db, projectId).append({
      eventType: 'review',
      toolName: 'review_project',
      graphHash,
      policyVersion: input.policyVersion,
      outcome: result,
    });
    return {
      ledgerRecordId: ledgerRecord.id,
      ledgerRecordHash: ledgerRecord.recordHash,
      replayEventId: replayEvent.id,
      replayEventHash: replayEvent.eventHash,
    };
  } catch (error) {
    logger.warn('Review decision audit could not be persisted; review output remains available.', {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
