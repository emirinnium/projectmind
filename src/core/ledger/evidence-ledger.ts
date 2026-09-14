import { z } from 'zod';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import type { KnowledgeGraph } from '../../storage/knowledge-graph.js';
import { stableHash } from '../../utils/hash.js';
import { currentModuleDir, resolvePackageVersion } from '../../utils/version.js';

const SHA256 = /^[a-f0-9]{64}$/;

export const ledgerEventSchema = z.object({
  eventType: z.enum(['mcp-invocation', 'scan', 'context', 'review', 'edit', 'custom']),
  toolName: z.string().trim().min(1).max(200),
  input: z.unknown(),
  result: z.unknown(),
  graphHash: z.string().regex(SHA256).nullable().optional(),
  policyVersion: z.string().trim().min(1).max(100).nullable().optional(),
  scope: z.string().trim().min(1).max(500).nullable().optional(),
  sourceFreshness: z
    .enum(['fresh', 'stale', 'unindexed', 'missing', 'unknown', 'not-checked'])
    .nullable()
    .optional(),
  summary: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .optional(),
});

export type LedgerEventInput = z.input<typeof ledgerEventSchema>;
export type LedgerEventType = z.infer<typeof ledgerEventSchema>['eventType'];

export interface EvidenceLedgerRecord {
  id: number;
  projectId: number;
  eventType: LedgerEventType;
  toolName: string;
  inputHash: string;
  graphHash: string | null;
  policyVersion: string;
  toolVersion: string;
  scope: string | null;
  sourceFreshness: string;
  resultHash: string;
  summary: Record<string, string | number | boolean | null>;
  previousHash: string | null;
  recordHash: string;
  createdAt: string;
}

export interface LedgerIssue {
  id: number;
  code:
    | 'previous-hash-mismatch'
    | 'record-hash-mismatch'
    | 'invalid-hash'
    | 'project-mismatch'
    | 'record-order-mismatch'
    | 'export-incomplete';
  message: string;
}

export interface LedgerVerification {
  valid: boolean;
  projectId: number;
  checkedRecords: number;
  chainHead: string | null;
  issues: LedgerIssue[];
}

export interface EvidenceLedgerExport {
  format: 'projectmind-evidence-ledger-v1';
  projectId: number;
  totalRecords: number;
  complete: boolean;
  records: EvidenceLedgerRecord[];
}

export interface LedgerListOptions {
  afterId?: number;
  limit?: number;
}

export interface LedgerInvocationSummary {
  success?: boolean;
  status?: string;
  claimStatus?: string;
  contentBlocks?: number;
  outputKeys?: string[];
}

const ledgerSummaryValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const evidenceLedgerRecordSchema = z.object({
  id: z.number().int().positive(),
  projectId: z.number().int().positive(),
  eventType: z.enum(['mcp-invocation', 'scan', 'context', 'review', 'edit', 'custom']),
  toolName: z.string().min(1),
  inputHash: z.string().regex(SHA256),
  graphHash: z.string().regex(SHA256).nullable(),
  policyVersion: z.string(),
  toolVersion: z.string(),
  scope: z.string().nullable(),
  sourceFreshness: z.string(),
  resultHash: z.string().regex(SHA256),
  summary: z.record(z.string(), ledgerSummaryValueSchema),
  previousHash: z.string().regex(SHA256).nullable(),
  recordHash: z.string().regex(SHA256),
  createdAt: z.string().datetime({ offset: true }),
});

export const evidenceLedgerExportSchema = z.object({
  format: z.literal('projectmind-evidence-ledger-v1'),
  projectId: z.number().int().positive(),
  totalRecords: z.number().int().nonnegative().optional(),
  complete: z.boolean().optional(),
  records: z.array(evidenceLedgerRecordSchema).max(100_000),
});

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => [key, canonicalize(record[key])]),
    );
  }
  return String(value);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function safeSummary(summary: LedgerInvocationSummary | undefined): string {
  const allowed: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(summary ?? {})) {
    if (key === 'outputKeys' && Array.isArray(value)) {
      allowed[key] = value.slice(0, 100).map(String).join(',');
    } else if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      allowed[key] = typeof value === 'string' ? value.slice(0, 500) : value;
    }
  }
  return JSON.stringify(canonicalize(allowed));
}

function parseSummary(value: SQLOutputValue): Record<string, string | number | boolean | null> {
  if (typeof value !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: Record<string, string | number | boolean | null> = {};
    for (const [key, item] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        item === null ||
        typeof item === 'string' ||
        typeof item === 'number' ||
        typeof item === 'boolean'
      ) {
        result[key] = item;
      }
    }
    return result;
  } catch {
    return {};
  }
}

function rowToRecord(row: Record<string, SQLOutputValue>): EvidenceLedgerRecord {
  return {
    id: Number(row.id),
    projectId: Number(row.project_id),
    eventType: row.event_type as LedgerEventType,
    toolName: String(row.tool_name),
    inputHash: String(row.input_hash),
    graphHash: row.graph_hash === null ? null : String(row.graph_hash),
    policyVersion: String(row.policy_version),
    toolVersion: String(row.tool_version),
    scope: row.scope === null ? null : String(row.scope),
    sourceFreshness: String(row.source_freshness),
    resultHash: String(row.result_hash),
    summary: parseSummary(row.summary),
    previousHash: row.previous_hash === null ? null : String(row.previous_hash),
    recordHash: String(row.record_hash),
    createdAt: String(row.created_at),
  };
}

function recordHash(record: Omit<EvidenceLedgerRecord, 'id' | 'recordHash'>): string {
  return stableHash(
    canonicalJson({
      projectId: record.projectId,
      eventType: record.eventType,
      toolName: record.toolName,
      inputHash: record.inputHash,
      graphHash: record.graphHash,
      policyVersion: record.policyVersion,
      toolVersion: record.toolVersion,
      scope: record.scope,
      sourceFreshness: record.sourceFreshness,
      resultHash: record.resultHash,
      summary: record.summary,
      previousHash: record.previousHash,
      createdAt: record.createdAt,
    }),
  );
}

/**
 * Verify an exported record set without opening a ProjectMind database.
 * Records are intentionally verified in the supplied order so an export that
 * drops, duplicates, or reorders a record cannot appear valid accidentally.
 */
export function verifyLedgerRecords(
  projectId: number,
  records: readonly EvidenceLedgerRecord[],
): LedgerVerification {
  const issues: LedgerIssue[] = [];
  let previousHash: string | null = null;
  let previousId = 0;
  for (const record of records) {
    if (record.projectId !== projectId) {
      issues.push({
        id: record.id,
        code: 'project-mismatch',
        message: `Record ${record.id} belongs to project ${record.projectId}, not project ${projectId}.`,
      });
    }
    if (record.id <= previousId) {
      issues.push({
        id: record.id,
        code: 'record-order-mismatch',
        message: `Record ${record.id} is not strictly after record ${previousId}.`,
      });
    }
    if (record.previousHash !== previousHash) {
      issues.push({
        id: record.id,
        code: 'previous-hash-mismatch',
        message: `Record ${record.id} points to ${record.previousHash ?? 'nothing'}, expected ${previousHash ?? 'chain start'}.`,
      });
    }
    const expected = recordHash(record);
    if (
      !SHA256.test(record.recordHash) ||
      !SHA256.test(record.inputHash) ||
      !SHA256.test(record.resultHash)
    ) {
      issues.push({
        id: record.id,
        code: 'invalid-hash',
        message: `Record ${record.id} contains a malformed hash value.`,
      });
    } else if (expected !== record.recordHash) {
      issues.push({
        id: record.id,
        code: 'record-hash-mismatch',
        message: `Record ${record.id} content does not match its record hash.`,
      });
    }
    previousHash = record.recordHash;
    previousId = record.id;
  }
  return {
    valid: issues.length === 0,
    projectId,
    checkedRecords: records.length,
    chainHead: previousHash,
    issues: issues.slice(0, 50),
  };
}

/** Verify an export and reject a deliberately bounded/incomplete backup. */
export function verifyLedgerExport(bundle: EvidenceLedgerExport): LedgerVerification {
  const verification = verifyLedgerRecords(bundle.projectId, bundle.records);
  const expectedTotal = bundle.totalRecords ?? bundle.records.length;
  const incomplete = bundle.complete === false || expectedTotal > bundle.records.length;
  if (!incomplete) return verification;
  const id = bundle.records.at(-1)?.id ?? 0;
  const issue: LedgerIssue = {
    id,
    code: 'export-incomplete',
    message: `Ledger export contains ${bundle.records.length} of ${expectedTotal} records; export the complete chain before treating it as a backup.`,
  };
  return {
    ...verification,
    valid: false,
    issues: [...verification.issues, issue].slice(0, 50),
  };
}

/** Append-only, hash-chained local audit records. Payload contents are never stored. */
export class EvidenceLedger {
  private readonly toolVersion = resolvePackageVersion(currentModuleDir(import.meta.url));

  constructor(
    private readonly db: DatabaseSync,
    private readonly projectId: number,
  ) {}

  append(input: LedgerEventInput): EvidenceLedgerRecord {
    const parsed = ledgerEventSchema.parse(input);
    // A single SQLite connection is synchronous, but multiple ProjectMind
    // processes can append to the same WAL database. Serialize the
    // previous-hash read and insert so concurrent appenders cannot create two
    // records pointing at the same chain predecessor. Respect a caller's
    // existing transaction to keep nested audit writes composable.
    if (this.db.isTransaction) return this.appendUnlocked(parsed);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const record = this.appendUnlocked(parsed);
      this.db.exec('COMMIT');
      return record;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch (rollbackError) {
        throw new Error('Evidence ledger append failed and rollback also failed.', {
          cause: rollbackError,
        });
      }
      throw error;
    }
  }

  private appendUnlocked(parsed: z.output<typeof ledgerEventSchema>): EvidenceLedgerRecord {
    const previous = this.db
      .prepare(
        'SELECT record_hash FROM evidence_ledger WHERE project_id = ? ORDER BY id DESC LIMIT 1',
      )
      .get(this.projectId) as { record_hash?: string } | undefined;
    const now = new Date().toISOString();
    const summary = safeSummary(parsed.summary);
    const base = {
      projectId: this.projectId,
      eventType: parsed.eventType,
      toolName: parsed.toolName,
      inputHash: stableHash(canonicalJson(parsed.input)),
      graphHash: parsed.graphHash ?? null,
      policyVersion: parsed.policyVersion ?? 'unknown',
      toolVersion: this.toolVersion,
      scope: parsed.scope ?? `project:${this.projectId}`,
      sourceFreshness: parsed.sourceFreshness ?? 'not-checked',
      resultHash: stableHash(canonicalJson(parsed.result)),
      summary: JSON.parse(summary) as Record<string, string | number | boolean | null>,
      previousHash: previous?.record_hash ?? null,
      createdAt: now,
    } satisfies Omit<EvidenceLedgerRecord, 'id' | 'recordHash'>;
    const hash = recordHash(base);
    const result = this.db
      .prepare(
        `INSERT INTO evidence_ledger
         (project_id, event_type, tool_name, input_hash, graph_hash, policy_version,
          tool_version, scope, source_freshness, result_hash, summary, previous_hash,
          record_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        base.projectId,
        base.eventType,
        base.toolName,
        base.inputHash,
        base.graphHash,
        base.policyVersion,
        base.toolVersion,
        base.scope,
        base.sourceFreshness,
        base.resultHash,
        summary,
        base.previousHash,
        hash,
        base.createdAt,
      );
    return { id: Number(result.lastInsertRowid), ...base, recordHash: hash };
  }

  list(options: LedgerListOptions = {}): EvidenceLedgerRecord[] {
    const limit = Math.max(1, Math.min(1000, Math.floor(options.limit ?? 100)));
    const afterId = options.afterId ?? 0;
    const rows = this.db
      .prepare(
        'SELECT * FROM evidence_ledger WHERE project_id = ? AND id > ? ORDER BY id ASC LIMIT ?',
      )
      .all(this.projectId, afterId, limit) as Record<string, SQLOutputValue>[];
    return rows.map(rowToRecord);
  }

  exportRecords(limit = 100_000): EvidenceLedgerExport {
    const boundedLimit = Math.max(1, Math.min(100_000, Math.floor(limit)));
    const totalRecords = Number(
      (
        this.db
          .prepare('SELECT COUNT(*) AS count FROM evidence_ledger WHERE project_id = ?')
          .get(this.projectId) as { count?: number | bigint } | undefined
      )?.count ?? 0,
    );
    const rows = this.db
      .prepare('SELECT * FROM evidence_ledger WHERE project_id = ? ORDER BY id ASC LIMIT ?')
      .all(this.projectId, boundedLimit) as Record<string, SQLOutputValue>[];
    return {
      format: 'projectmind-evidence-ledger-v1',
      projectId: this.projectId,
      totalRecords,
      complete: rows.length >= totalRecords,
      records: rows.map(rowToRecord),
    };
  }

  verify(): LedgerVerification {
    const rows = this.db
      .prepare('SELECT * FROM evidence_ledger WHERE project_id = ? ORDER BY id ASC')
      .all(this.projectId) as Record<string, SQLOutputValue>[];
    return verifyLedgerRecords(this.projectId, rows.map(rowToRecord));
  }
}

export function summarizeLedgerInvocation(value: unknown): LedgerInvocationSummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { status: 'non-object-result' };
  }
  const record = value as Record<string, unknown>;
  const content = Array.isArray(record.content) ? record.content : undefined;
  return {
    ...(typeof record.success === 'boolean' ? { success: record.success } : {}),
    ...(typeof record.status === 'string' ? { status: record.status } : {}),
    ...(typeof record.claimStatus === 'string' ? { claimStatus: record.claimStatus } : {}),
    ...(content ? { contentBlocks: content.length } : {}),
    outputKeys: Object.keys(record)
      .filter((key) => key !== 'content')
      .sort()
      .slice(0, 100),
  };
}

export function computeIndexedGraphHash(kg: Pick<KnowledgeGraph, 'getAllFiles'>): string {
  return stableHash(
    canonicalJson(
      kg
        .getAllFiles()
        .map((file) => ({ path: file.relativePath, hash: file.hash, language: file.language }))
        .sort((left, right) => left.path.localeCompare(right.path)),
    ),
  );
}
