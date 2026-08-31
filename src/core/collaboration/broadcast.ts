/**
 * Real-Time Collaborative Agent Context — Intent Broadcast + Conflict Prediction.
 *
 * INFORMATION-LEAK SANITIZATION (F45/F18) — IMPLEMENTED HERE, NOT DOCUMENTATION:
 * Before an intent is persisted or broadcast, the current git branch is
 * determined via `git branch --show-current` (child_process). If the branch
 * matches a private-branch pattern (default: `private\/*`, `personal\/*`,
 * `wip\/*`, `secret\/*` — configurable via constructor options), the intent is
 * NEVER written to the shared database: it is kept in-memory only, scoped to
 * this agent instance, and marked `scope: 'local'`. Only intents from public
 * branches are persisted to `pending_intents` and visible cross-process.
 * If branch detection fails (not a git repo, git missing), a configurable
 * public-safe fallback branch is assumed (default: 'main').
 *
 * EXPIRY FORMAT (F20): the single canonical `expires_at` format is INTEGER
 * unix milliseconds. Every INSERT stores `Date.now() + ttlSeconds * 1000` and
 * every expiry query compares against an integer (`WHERE expires_at < ?`).
 * Legacy DB rows written as datetime/ISO strings are reconciled by a separate
 * migration (WP8); runtime code no longer mixes formats.
 */
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { IntentBroadcast, ConflictPrediction } from './types.js';

/** Default intent time-to-live (seconds). */
export const DEFAULT_TTL_SECONDS = 300;

/** Branch name patterns considered private (never persisted / shared). */
export const DEFAULT_PRIVATE_BRANCH_PATTERNS: RegExp[] = [
  /^private\//i,
  /^personal\//i,
  /^wip\//i,
  /^secret\//i,
];

export interface IntentBroadcastOptions {
  /** Private-branch patterns (defaults to DEFAULT_PRIVATE_BRANCH_PATTERNS). */
  privateBranchPatterns?: RegExp[];
  /** Branch assumed when git detection fails (public-safe default). */
  fallbackBranch?: string;
  /** Injectable branch detector; returned null falls back to fallbackBranch. */
  branchDetector?: () => string | null;
}

type PendingIntentRow = {
  id: number | string;
  agent_id: string;
  intent_type: string;
  target_files: string;
  session_id: string | null;
  description: string | null;
  expected_changes: string | null;
  broadcast_at: number | string | null;
  expires_at: number | string | null;
};

/** Parse a stored timestamp that may be unix ms (new) or datetime/ISO (legacy). */
function parseStoredTimestamp(value: number | string | null | undefined): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber) && value.trim() !== '') return asNumber;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function isExpired(b: IntentBroadcast, now: number): boolean {
  const ttl = b.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  return b.timestamp + ttl * 1000 < now;
}

/**
 * Strict parser for stored `target_files` payloads. JSON.parse alone is NOT
 * enough: valid JSON that is not a string array ('42', '{}', 'null', '"str"')
 * would pass the parse and then throw on `.includes`/spread, poisoning
 * conflict detection for every row processed afterwards. Returns undefined
 * for anything that is not exactly a string[] so callers can skip the row.
 */
function parseTargetFiles(raw: string | null | undefined): string[] | undefined {
  if (typeof raw !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
      return parsed;
    }
  } catch {
    // malformed JSON — treated the same as wrong-shaped JSON
  }
  return undefined;
}

/**
 * Strict parser for stored `expected_changes` payloads: must decode to a
 * plain object (the ExpectedChanges shape) or be discarded. Scalars/arrays
 * are valid JSON but would break downstream consumers expecting an object.
 */
function parseExpectedChanges(raw: string | null | undefined): IntentBroadcast['expectedChanges'] | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as IntentBroadcast['expectedChanges'];
    }
  } catch {
    // malformed JSON — keep the intent without structured changes
  }
  return undefined;
}

/**
 * Defensive ingestion guard: activeIntents must NEVER hold anything but a
 * real string[] — runtime callers may hand us garbage despite the types.
 */
function sanitizeTargetFiles(files: unknown): string[] {
  return Array.isArray(files) ? files.filter((f): f is string => typeof f === 'string') : [];
}

export class IntentBroadcastService {
  private subscribers = new Map<string, Array<(broadcast: IntentBroadcast) => void>>();
  private activeIntents = new Map<string, IntentBroadcast[]>(); // agentId -> broadcasts
  private readonly privateBranchPatterns: RegExp[];
  private readonly fallbackBranch: string;
  private readonly branchDetector?: () => string | null;
  private schemaChecked = false;

  constructor(private db?: DatabaseSync, options: IntentBroadcastOptions = {}) {
    this.privateBranchPatterns = options.privateBranchPatterns ?? DEFAULT_PRIVATE_BRANCH_PATTERNS;
    this.fallbackBranch = options.fallbackBranch ?? 'main';
    this.branchDetector = options.branchDetector;
  }

  /**
   * Broadcast an intent. The caller's object is never mutated: a clone is
   * stamped with id/timestamp, sanitized against the current branch, and then
   * persisted (public branches only) + stored in memory + pushed to subscribers.
   * Returns the stamped clone.
   */
  broadcastIntent(broadcast: IntentBroadcast): IntentBroadcast {
    // F22: clone before stamping — never mutate the caller's object.
    // Ingestion hardening: targetFiles is sanitized to a real string[] so
    // activeIntents can never hold a malformed entry (runtime callers may
    // pass non-arrays despite the type signature).
    const b: IntentBroadcast = {
      ...broadcast,
      targetFiles: sanitizeTargetFiles(broadcast.targetFiles),
      expectedChanges: broadcast.expectedChanges
        ? (JSON.parse(JSON.stringify(broadcast.expectedChanges)) as IntentBroadcast['expectedChanges'])
        : undefined,
    };
    b.ttlSeconds = b.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    b.id = b.id ?? randomUUID();
    b.timestamp = b.timestamp || Date.now();

    // F45/F18: private-branch sanitization — local-only, never persisted.
    const branch = this.detectBranch();
    b.scope = this.isPrivateBranch(branch) ? 'local' : 'shared';

    if (b.scope === 'shared') {
      this.persistIntent(b);
    }

    // Store in-memory for conflict prediction (dedupe by id).
    const list = this.activeIntents.get(b.agentId) ?? [];
    if (!list.some((x) => x.id === b.id)) {
      list.push(b);
      this.activeIntents.set(b.agentId, list);
    }

    // Notify subscribers (never the broadcasting agent itself).
    for (const [agentId, callbacks] of this.subscribers) {
      if (agentId === b.agentId) continue;
      for (const cb of callbacks) {
        try {
          cb(b);
        } catch {
          // ignore subscriber errors
        }
      }
    }

    return b;
  }

  /**
   * Subscribe to intents. F21: loads OTHER agents' active, unexpired intents
   * from the shared DB (never the subscriber's own) and dedupes by intent id,
   * so double-subscribing does not create duplicate in-memory entries.
   */
  subscribeToIntents(agentId: string, callback: (broadcast: IntentBroadcast) => void): () => void {
    if (!this.subscribers.has(agentId)) {
      this.subscribers.set(agentId, []);
    }
    const list = this.subscribers.get(agentId)!;
    list.push(callback);

    if (this.db) {
      try {
        this.ensureSchema(this.db);
        const rows = this.db
          .prepare(
            `SELECT id, agent_id, intent_type, target_files, session_id, description,
                    expected_changes, broadcast_at, expires_at
             FROM pending_intents
             WHERE agent_id != ? AND expires_at >= ?`
          )
          .all(agentId, Date.now()) as PendingIntentRow[];

        for (const row of rows) {
          const id = String(row.id);
          const agentList = this.activeIntents.get(row.agent_id) ?? [];
          if (agentList.some((x) => x.id === id)) continue; // dedupe by intent id

          // Strict shape validation: valid-JSON-but-not-string[] payloads
          // ('42', '{}', 'null', '"str"') are poison — skip the row entirely
          // so they can never enter activeIntents or reach checkConflict.
          const targetFiles = parseTargetFiles(row.target_files);
          if (targetFiles === undefined) continue;

          const timestamp = parseStoredTimestamp(row.broadcast_at);
          const expiresAt = parseStoredTimestamp(row.expires_at);
          const expectedChanges = parseExpectedChanges(row.expected_changes);
          const existing: IntentBroadcast = {
            id,
            agentId: row.agent_id,
            intentType: row.intent_type as IntentBroadcast['intentType'],
            targetFiles,
            timestamp,
            sessionId: row.session_id ?? undefined,
            description: row.description ?? undefined,
            expectedChanges,
            ttlSeconds:
              expiresAt > timestamp
                ? Math.max(1, Math.round((expiresAt - timestamp) / 1000))
                : DEFAULT_TTL_SECONDS,
            scope: 'shared',
          };
          agentList.push(existing);
          this.activeIntents.set(row.agent_id, agentList);

          try {
            callback(existing);
          } catch {
            // ignore subscriber errors
          }
        }
      } catch {
        // ignore DB errors — subscription stays live for future broadcasts
      }
    }

    return () => {
      const idx = list.indexOf(callback);
      if (idx >= 0) list.splice(idx, 1);
    };
  }

  /**
   * F19: remove ONLY expired intents. DB rows are deleted by integer
   * comparison; in-memory lists are filtered per agent (active, unexpired
   * intents survive).
   */
  expireIntents(): void {
    const now = Date.now();
    if (this.db) {
      try {
        this.db.prepare('DELETE FROM pending_intents WHERE expires_at < ?').run(now);
      } catch {
        // ignore DB errors
      }
    }
    for (const [agentId, broadcasts] of this.activeIntents) {
      const alive = broadcasts.filter((b) => !isExpired(b, now));
      if (alive.length === 0) {
        this.activeIntents.delete(agentId);
      } else {
        this.activeIntents.set(agentId, alive);
      }
    }
  }

  /**
   * Predict conflicts for `agentId` writing `targetFiles`.
   * F19: expired intents are filtered out BEFORE conflict evaluation.
   */
  checkConflict(agentId: string, targetFiles: string[]): ConflictPrediction {
    const now = Date.now();
    const conflicts: string[] = [];
    const conflictingAgents: string[] = [];
    const conflictingFiles: string[] = [];

    const record = (otherAgentId: string, file: string): void => {
      if (!conflictingAgents.includes(otherAgentId)) conflictingAgents.push(otherAgentId);
      if (!conflictingFiles.includes(file)) conflictingFiles.push(file);
      if (!conflicts.includes(`${otherAgentId}:${file}`)) conflicts.push(`${otherAgentId}:${file}`);
    };

    // In-memory active intents (expired filtered first — F19).
    for (const [otherAgentId, broadcasts] of this.activeIntents) {
      if (otherAgentId === agentId) continue;
      for (const b of broadcasts) {
        if (isExpired(b, now)) continue;
        if (b.intentType === 'read') continue; // read-only doesn't conflict
        // Defensive: ingestion sanitizes targetFiles, but a malformed entry
        // must be SKIPPED here, never thrown on — checkConflict must not
        // throw uncaught out of the method.
        if (!Array.isArray(b.targetFiles)) continue;
        for (const f of targetFiles) {
          if (b.targetFiles.includes(f)) record(otherAgentId, f);
        }
      }
    }

    // DB pending_intents for cross-process visibility (integer expiry — F20).
    if (this.db) {
      try {
        const rows = this.db
          .prepare(
            `SELECT agent_id, intent_type, target_files
             FROM pending_intents
             WHERE intent_type != 'read' AND expires_at >= ?`
          )
          .all(now) as Array<{ agent_id: string; intent_type: string; target_files: string }>;

        for (const row of rows) {
          if (row.agent_id === agentId) continue;
          // Strict shape validation: a valid-JSON-but-not-string[] payload
          // ('42','{}','null','"str"') passes JSON.parse and then throws on
          // `.includes` — that throw lands in the OUTER catch and blinds
          // conflict detection for every subsequent DB row. Skip it only.
          const dbTargetFiles = parseTargetFiles(row.target_files);
          if (dbTargetFiles === undefined) continue;
          for (const f of targetFiles) {
            if (dbTargetFiles.includes(f)) record(row.agent_id, f);
          }
        }
      } catch {
        // ignore DB errors
      }
    }

    const hasConflict = conflictingAgents.length > 0;
    let riskLevel: 'low' | 'medium' | 'high' = 'low';
    if (hasConflict) {
      riskLevel = conflictingAgents.length >= 2 ? 'high' : 'medium';
    }

    const reasons: string[] = [];
    if (hasConflict) {
      for (const a of conflictingAgents) {
        reasons.push(`Agent ${a} has write/refactor/delete intent on overlapping files.`);
      }
    } else {
      reasons.push('No overlapping write intents detected.');
    }

    return { hasConflict, conflictingAgents, conflictingFiles, riskLevel, reasons };
  }

  /**
    * Active (unexpired) intents from OTHER agents, merged from in-memory
    * broadcasts and the shared DB. Used by read paths (e.g. get_context
    * conflict warnings) that need per-intent detail rather than the aggregate
    * {@link checkConflict} verdict. Never throws: DB problems simply shrink
    * the result to the in-memory set.
    *
    * Dedup is by CONTENT (agentId|intentType|targetFiles|timestamp), not by
    * id: the in-memory copy carries the broadcaster's UUID while the persisted
    * row carries an integer row-id, so id-based dedup would double-report the
    * same intent.
    */
  getActiveIntents(excludeAgentId?: string): IntentBroadcast[] {
    const now = Date.now();
    const seen = new Set<string>();
    const out: IntentBroadcast[] = [];

    const contentKey = (agentId: string, intentType: string, targetFiles: string[], timestamp: number): string =>
      `${agentId}|${intentType}|${[...targetFiles].sort().join(',')}|${timestamp}`;

    for (const [agentId, broadcasts] of this.activeIntents) {
      if (excludeAgentId !== undefined && agentId === excludeAgentId) continue;
      for (const b of broadcasts) {
        if (isExpired(b, now)) continue;
        // Defensive: contentKey spreads targetFiles — a malformed entry must
        // be skipped, never thrown on.
        if (!Array.isArray(b.targetFiles)) continue;
        const key = contentKey(b.agentId, b.intentType, b.targetFiles, b.timestamp);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(b);
      }
    }

    if (this.db) {
      try {
        this.ensureSchema(this.db);
        const rows = this.db
          .prepare(
            `SELECT id, agent_id, intent_type, target_files, session_id, description,
                    expected_changes, broadcast_at, expires_at
             FROM pending_intents
             WHERE expires_at >= ?`
          )
          .all(now) as PendingIntentRow[];

        for (const row of rows) {
          if (excludeAgentId !== undefined && row.agent_id === excludeAgentId) continue;
          // Strict shape validation: a valid-JSON-but-not-string[] payload
          // passes JSON.parse and then throws on the contentKey spread below,
          // wiping every subsequent row via the outer catch. Skip it only.
          const targetFiles = parseTargetFiles(row.target_files);
          if (targetFiles === undefined) continue;
          const timestamp = parseStoredTimestamp(row.broadcast_at);
          const expiresAt = parseStoredTimestamp(row.expires_at);
          const expectedChanges = parseExpectedChanges(row.expected_changes);
          const key = contentKey(row.agent_id, row.intent_type, targetFiles, timestamp);
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({
            id: String(row.id),
            agentId: row.agent_id,
            intentType: row.intent_type as IntentBroadcast['intentType'],
            targetFiles,
            timestamp,
            sessionId: row.session_id ?? undefined,
            description: row.description ?? undefined,
            expectedChanges,
            ttlSeconds:
              expiresAt > timestamp
                ? Math.max(1, Math.round((expiresAt - timestamp) / 1000))
                : DEFAULT_TTL_SECONDS,
            scope: 'shared',
          });
        }
      } catch {
        // ignore DB errors — in-memory intents already collected
      }
    }

    return out;
  }

  clearIntents(agentId?: string): void {
    if (agentId) {
      this.activeIntents.delete(agentId);
    } else {
      this.activeIntents.clear();
    }
  }

  /** Current branch via git; falls back to the configured public-safe default. */
  private detectBranch(): string {
    if (this.branchDetector) {
      try {
        return this.branchDetector() ?? this.fallbackBranch;
      } catch {
        return this.fallbackBranch;
      }
    }
    try {
      // execFileSync with an argument array — never interpolate into a shell
      // command string; stderr ignored so non-git CWDs stay silent on stdio.
      const out = execFileSync('git', ['branch', '--show-current'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2000,
      }).trim();
      return out || this.fallbackBranch;
    } catch {
      return this.fallbackBranch;
    }
  }

  private isPrivateBranch(branch: string): boolean {
    return this.privateBranchPatterns.some((p) => p.test(branch));
  }

  /** Persist a sanitized intent with integer unix-ms expiry (F20). */
  private persistIntent(b: IntentBroadcast): void {
    if (!this.db) return;
    try {
      this.ensureSchema(this.db);
      const expiresAt = Date.now() + (b.ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1000;
      this.db
        .prepare(
          `INSERT INTO pending_intents
             (agent_id, intent_type, target_files, session_id, description,
              expected_changes, broadcast_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          b.agentId,
          b.intentType,
          JSON.stringify(b.targetFiles),
          b.sessionId ?? null,
          b.description ?? null,
          b.expectedChanges ? JSON.stringify(b.expectedChanges) : null,
          b.timestamp,
          expiresAt
        );
    } catch {
      // ignore DB errors to keep broadcast resilient
    }
  }

  /**
   * Ensure the pending_intents table carries every column the runtime uses.
   * Fresh DBs get them from schema.ts; older DBs (pre-expected_changes, or the
   * legacy migration-92 shape) are upgraded defensively. A dedicated WP8
   * migration reconciles legacy row VALUES (datetime strings -> unix ms).
   */
  private ensureSchema(db: DatabaseSync): void {
    if (this.schemaChecked) return;
    this.schemaChecked = true;
    try {
      const cols = db.prepare('PRAGMA table_info(pending_intents)').all() as Array<{ name: string }>;
      const names = new Set(cols.map((c) => c.name));
      const additions: Array<[string, string]> = [
        ['session_id', 'TEXT'],
        ['description', 'TEXT'],
        ['expected_changes', 'TEXT'],
        ['broadcast_at', 'INTEGER DEFAULT 0'],
        ['expires_at', 'INTEGER NOT NULL DEFAULT 0'],
      ];
      for (const [col, def] of additions) {
        if (!names.has(col)) {
          db.exec(`ALTER TABLE pending_intents ADD COLUMN ${col} ${def};`);
        }
      }
    } catch {
      // Table may not exist at all — inserts will no-op via their try/catch.
    }
  }
}
