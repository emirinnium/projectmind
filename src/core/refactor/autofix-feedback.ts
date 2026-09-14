import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export type AutoFixFeedbackValue = 'accepted' | 'rejected' | 'skipped';
export type AutoFixRecommendationStatus =
  'recommend' | 'avoid' | 'insufficient-evidence' | 'opted-out';

export interface AutoFixFeedbackInput {
  fixer: string;
  feedback: AutoFixFeedbackValue;
  agentName?: string;
  sourceHash?: string;
  policyVersion?: string;
}

export interface AutoFixFeedbackRecord extends AutoFixFeedbackInput {
  id: number;
  projectId: number;
  createdAt: string;
}

export interface AutoFixRecommendation {
  fixer: string;
  accepted: number;
  rejected: number;
  skipped: number;
  decidedSamples: number;
  acceptanceRate: number | null;
  confidence: number;
  interval: { lower: number; upper: number; level: 0.95 } | null;
  status: AutoFixRecommendationStatus;
  reason: string;
}

export interface AutoFixFeedbackReset {
  resetId: number;
  projectId: number;
  agentName?: string;
  feedbackBoundary: number;
  resetAt: string;
}

const DEFAULT_POLICY_VERSION = 'autofix-feedback-v1';

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS autofix_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  agent_name TEXT,
  fixer TEXT NOT NULL,
  feedback TEXT NOT NULL CHECK(feedback IN ('accepted', 'rejected', 'skipped')),
  source_hash TEXT CHECK(source_hash IS NULL OR length(source_hash) = 64),
  policy_version TEXT NOT NULL DEFAULT 'autofix-feedback-v1',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_autofix_feedback_project_fixer
  ON autofix_feedback(project_id, fixer, agent_name, id);
CREATE TRIGGER IF NOT EXISTS autofix_feedback_no_update
  BEFORE UPDATE ON autofix_feedback
  BEGIN
    SELECT RAISE(ABORT, 'autofix_feedback is append-only');
  END;
CREATE TRIGGER IF NOT EXISTS autofix_feedback_no_delete
  BEFORE DELETE ON autofix_feedback
  BEGIN
    SELECT RAISE(ABORT, 'autofix_feedback is append-only');
  END;
CREATE TABLE IF NOT EXISTS autofix_feedback_preferences (
  project_id INTEGER NOT NULL,
  agent_key TEXT NOT NULL,
  opted_out INTEGER NOT NULL CHECK(opted_out IN (0, 1)),
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(project_id, agent_key)
);
CREATE TABLE IF NOT EXISTS autofix_feedback_resets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  agent_key TEXT NOT NULL,
  feedback_boundary INTEGER NOT NULL DEFAULT 0,
  reset_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_autofix_feedback_resets_scope
  ON autofix_feedback_resets(project_id, agent_key, id);
CREATE TRIGGER IF NOT EXISTS autofix_feedback_resets_no_update
  BEFORE UPDATE ON autofix_feedback_resets
  BEGIN
    SELECT RAISE(ABORT, 'autofix_feedback_resets is append-only');
  END;
CREATE TRIGGER IF NOT EXISTS autofix_feedback_resets_no_delete
  BEFORE DELETE ON autofix_feedback_resets
  BEGIN
    SELECT RAISE(ABORT, 'autofix_feedback_resets is append-only');
  END;
`;

function normalizeAgentKey(agentName: string | undefined): string {
  return agentName?.trim() ?? '';
}

function normalizeAgentName(agentName: string | undefined): string | undefined {
  const normalized = agentName?.trim();
  return normalized || undefined;
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function wilsonInterval(
  successes: number,
  trials: number,
): { lower: number; upper: number; level: 0.95 } {
  const z = 1.96;
  const p = successes / trials;
  const denominator = 1 + (z * z) / trials;
  const center = (p + (z * z) / (2 * trials)) / denominator;
  const spread =
    (z * Math.sqrt((p * (1 - p)) / trials + (z * z) / (4 * trials * trials))) / denominator;
  return {
    lower: Math.round(clamp(center - spread) * 10000) / 10000,
    upper: Math.round(clamp(center + spread) * 10000) / 10000,
    level: 0.95,
  };
}

function formatCount(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/** Project-scoped, append-only feedback with explicit opt-out and logical reset controls. */
export class AutoFixFeedbackStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly projectId: number,
  ) {
    this.db.exec(CREATE_TABLE_SQL);
    const columns = this.db.prepare('PRAGMA table_info(autofix_feedback)').all() as Array<{
      name: string;
    }>;
    if (!columns.some((column) => column.name === 'policy_version')) {
      this.db.exec(
        `ALTER TABLE autofix_feedback ADD COLUMN policy_version TEXT NOT NULL DEFAULT '${DEFAULT_POLICY_VERSION}'`,
      );
    }
    const resetColumns = this.db
      .prepare('PRAGMA table_info(autofix_feedback_resets)')
      .all() as Array<{ name: string }>;
    if (!resetColumns.some((column) => column.name === 'feedback_boundary')) {
      this.db.exec(
        'ALTER TABLE autofix_feedback_resets ADD COLUMN feedback_boundary INTEGER NOT NULL DEFAULT 0',
      );
    }
  }

  record(input: AutoFixFeedbackInput): AutoFixFeedbackRecord {
    const createdAt = new Date().toISOString();
    const agentName = normalizeAgentName(input.agentName);
    const policyVersion = input.policyVersion?.trim() || DEFAULT_POLICY_VERSION;
    if (this.isOptedOut(agentName)) {
      throw new Error(
        `Auto-fix feedback collection is opted out for ${agentName ? `agent '${agentName}'` : 'the default agent'}; run "pm autofix opt-in" to resume.`,
      );
    }
    const result = this.db
      .prepare(
        `INSERT INTO autofix_feedback
          (project_id, agent_name, fixer, feedback, source_hash, policy_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.projectId,
        agentName ?? null,
        input.fixer,
        input.feedback,
        input.sourceHash ?? null,
        policyVersion,
        createdAt,
      );
    return {
      ...input,
      agentName,
      policyVersion,
      id: Number(result.lastInsertRowid),
      projectId: this.projectId,
      createdAt,
    };
  }

  recommend(
    fixers: readonly string[],
    options: { agentName?: string; minimumSamples?: number; decayDays?: number } = {},
  ): AutoFixRecommendation[] {
    const uniqueFixers = [...new Set(fixers.map((fixer) => fixer.trim()).filter(Boolean))].sort();
    const minimumSamples = Math.max(1, Math.floor(options.minimumSamples ?? 3));
    const agentName = normalizeAgentName(options.agentName);
    const decayDays = options.decayDays;
    if (decayDays !== undefined && (!Number.isFinite(decayDays) || decayDays <= 0)) {
      throw new Error('--decay-days must be a positive number.');
    }
    if (this.isOptedOut(agentName)) {
      return uniqueFixers.map((fixer) => ({
        fixer,
        accepted: 0,
        rejected: 0,
        skipped: 0,
        decidedSamples: 0,
        acceptanceRate: null,
        confidence: 0,
        interval: null,
        status: 'opted-out',
        reason: 'Feedback collection is opted out for this agent scope.',
      }));
    }
    const reset = this.latestReset(agentName);
    const rows = this.db
      .prepare(
        `SELECT id, fixer, feedback, created_at
         FROM autofix_feedback
         WHERE project_id = ? AND (? IS NULL OR agent_name = ?)
           AND (? IS NULL OR id > ?)
         ORDER BY id ASC`,
      )
      .all(
        this.projectId,
        agentName ?? null,
        agentName ?? null,
        reset?.feedbackBoundary ?? null,
        reset?.feedbackBoundary ?? null,
      ) as Array<{
      id: number;
      fixer: string;
      feedback: AutoFixFeedbackValue;
      created_at: string;
    }>;
    const counts = new Map<string, { accepted: number; rejected: number; skipped: number }>();
    for (const fixer of uniqueFixers) counts.set(fixer, { accepted: 0, rejected: 0, skipped: 0 });
    for (const row of rows) {
      const count = counts.get(row.fixer);
      if (!count) continue;
      const ageDays = Math.max(0, (Date.now() - Date.parse(row.created_at)) / 86_400_000);
      const weight = decayDays === undefined ? 1 : Math.pow(0.5, ageDays / decayDays);
      count[row.feedback] += weight;
    }
    return [...counts.entries()].map(([fixer, count]) => {
      const decidedSamples = count.accepted + count.rejected;
      const acceptanceRate =
        decidedSamples === 0 ? null : Math.round((count.accepted / decidedSamples) * 10000) / 10000;
      const enough = decidedSamples >= minimumSamples;
      const status: AutoFixRecommendationStatus = !enough
        ? 'insufficient-evidence'
        : (acceptanceRate ?? 0) >= 0.6
          ? 'recommend'
          : (acceptanceRate ?? 0) <= 0.4
            ? 'avoid'
            : 'insufficient-evidence';
      return {
        fixer,
        ...count,
        decidedSamples,
        acceptanceRate,
        confidence: Math.round((decidedSamples / (decidedSamples + 5)) * 10000) / 10000,
        interval: decidedSamples === 0 ? null : wilsonInterval(count.accepted, decidedSamples),
        status,
        reason: !enough
          ? `${formatCount(decidedSamples)}/${minimumSamples} decided examples; do not personalize yet.`
          : `${formatCount(count.accepted)} accepted / ${formatCount(count.rejected)} rejected; skipped=${formatCount(count.skipped)}${decayDays === undefined ? '.' : `; half-life=${decayDays}d.`}`,
      };
    });
  }

  isOptedOut(agentName?: string): boolean {
    const row = this.db
      .prepare(
        `SELECT opted_out FROM autofix_feedback_preferences
         WHERE project_id = ? AND agent_key = ?`,
      )
      .get(this.projectId, normalizeAgentKey(agentName)) as { opted_out?: number } | undefined;
    return row?.opted_out === 1;
  }

  setOptOut(agentName: string | undefined, optedOut: boolean): void {
    this.db
      .prepare(
        `INSERT INTO autofix_feedback_preferences(project_id, agent_key, opted_out, updated_at)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(project_id, agent_key) DO UPDATE SET
           opted_out = excluded.opted_out,
           updated_at = CURRENT_TIMESTAMP`,
      )
      .run(this.projectId, normalizeAgentKey(agentName), optedOut ? 1 : 0);
  }

  reset(agentName?: string): AutoFixFeedbackReset {
    const resetAt = new Date().toISOString();
    const normalizedAgent = normalizeAgentName(agentName);
    const boundary = this.db
      .prepare(
        `SELECT COALESCE(MAX(id), 0) AS boundary FROM autofix_feedback
         WHERE project_id = ? AND (? IS NULL OR agent_name = ?)`,
      )
      .get(this.projectId, normalizedAgent ?? null, normalizedAgent ?? null) as {
      boundary: number;
    };
    const result = this.db
      .prepare(
        `INSERT INTO autofix_feedback_resets(project_id, agent_key, feedback_boundary, reset_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(this.projectId, normalizeAgentKey(agentName), Number(boundary.boundary), resetAt);
    return {
      resetId: Number(result.lastInsertRowid),
      projectId: this.projectId,
      agentName: normalizedAgent,
      feedbackBoundary: Number(boundary.boundary),
      resetAt,
    };
  }

  private latestReset(
    agentName?: string,
  ): { resetId: number; feedbackBoundary: number; resetAt: string } | undefined {
    const row = this.db
      .prepare(
        `SELECT id AS resetId, feedback_boundary AS feedbackBoundary, reset_at AS resetAt FROM autofix_feedback_resets
         WHERE project_id = ? AND agent_key = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(this.projectId, normalizeAgentKey(agentName)) as
      { resetId: number; feedbackBoundary: number; resetAt: string } | undefined;
    if (!row) return undefined;
    let feedbackBoundary = Number(row.feedbackBoundary);
    // v104 reset rows predate the explicit boundary column. Reconstruct their
    // boundary at read time so the append-only reset log never needs an UPDATE.
    if (feedbackBoundary === 0) {
      const fallback = this.db
        .prepare(
          `SELECT COALESCE(MAX(id), 0) AS boundary FROM autofix_feedback
           WHERE project_id = ? AND (? = '' OR agent_name = ?)
             AND created_at <= ?`,
        )
        .get(
          this.projectId,
          normalizeAgentKey(agentName),
          normalizeAgentKey(agentName),
          row.resetAt,
        ) as {
        boundary: number;
      };
      feedbackBoundary = Number(fallback.boundary);
    }
    return {
      resetId: Number(row.resetId),
      feedbackBoundary,
      resetAt: row.resetAt,
    };
  }
}

export function sourceHashForContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
