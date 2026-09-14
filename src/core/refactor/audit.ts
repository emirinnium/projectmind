import type { DatabaseSync } from 'node:sqlite';
import { AgentReplayStore } from '@/core/replay/agent-replay.js';
import { EvidenceLedger } from '@/core/ledger/evidence-ledger.js';
import { logger } from '@/utils/logger.js';

export interface EditDecisionAuditInput {
  filePath: string;
  fixer: string;
  sourceHash: string;
  resultHash: string;
  changed: boolean;
  written: boolean;
  postEditGatePassed?: boolean;
  reason?: string;
}

export interface EditDecisionAuditReceipt {
  ledgerRecordId: number;
  ledgerRecordHash: string;
  replayEventId: number;
  replayEventHash: string;
}

/**
 * Persist a payload-free edit decision in both audit chains.
 *
 * Source text and diffs are deliberately excluded. Hashes let a later
 * verifier prove which source versions were considered without turning the
 * local audit database into a source or secret store. Audit persistence is
 * best-effort so legacy databases never turn a safe preview into a failure.
 */
export function recordEditDecision(
  db: DatabaseSync | undefined,
  projectId: number | undefined,
  input: EditDecisionAuditInput,
): EditDecisionAuditReceipt | undefined {
  if (!db || projectId === undefined) return undefined;

  try {
    const result = {
      filePath: input.filePath,
      fixer: input.fixer,
      sourceHash: input.sourceHash,
      resultHash: input.resultHash,
      changed: input.changed,
      written: input.written,
      ...(input.postEditGatePassed === undefined
        ? {}
        : { postEditGatePassed: input.postEditGatePassed }),
      ...(input.reason ? { reason: input.reason } : {}),
    };
    const ledgerRecord = new EvidenceLedger(db, projectId).append({
      eventType: 'edit',
      toolName: 'auto_fix',
      input: {
        filePath: input.filePath,
        fixer: input.fixer,
        sourceHash: input.sourceHash,
      },
      result,
      scope: `project:${projectId}:${input.filePath}`,
      sourceFreshness: 'not-checked',
      summary: {
        changed: input.changed,
        written: input.written,
        fixer: input.fixer,
      },
    });
    const replayEvent = new AgentReplayStore(db, projectId).append({
      eventType: 'edit',
      toolName: 'auto_fix',
      filePath: input.filePath,
      sourceHash: input.sourceHash,
      outcome: result,
    });
    return {
      ledgerRecordId: ledgerRecord.id,
      ledgerRecordHash: ledgerRecord.recordHash,
      replayEventId: replayEvent.id,
      replayEventHash: replayEvent.eventHash,
    };
  } catch (error) {
    logger.warn('Edit decision audit could not be persisted; edit result remains available.', {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
