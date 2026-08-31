/**
 * Git-style 3-way merge (diff3) for team memory values.
 *
 * Replaces the "last-write-wins" upsert with a proper base/local/remote merge:
 *
 *   base   = the value stored BEFORE the currently stored one
 *           (tracked in team_memories.base_value)
 *   local  = the currently stored value
 *   remote = the incoming value being written
 *
 * The merge walks both diffs against `base` simultaneously:
 *   - regions changed by only ONE side are applied,
 *   - regions changed IDENTICALLY by both sides are applied once,
 *   - regions changed DIFFERENTLY by both sides become a conflict block
 *     (git-style `<<<<<<<` / `=======` / `>>>>>>>` markers).
 *
 * Conflict markers never win the write — the caller keeps the stored value
 * untouched on conflict and surfaces the LLM/heuristic suggestion instead.
 * That is the opposite of last-write-wins.
 *
 * This module is fully self-contained with zero imports, so it is trivially
 * unit-testable and safe for both the storage layer and the MCP layer to use.
 */

export interface DiffHunk {
  /** Base line range [start, end) covered by this change. Pure insertions have baseStart === baseEnd. */
  baseStart: number;
  baseEnd: number;
  /** Replacement lines produced by the changed side at that base range. */
  lines: string[];
}

export interface MergeConflict {
  baseStart: number;
  baseEnd: number;
  localLines: string[];
  remoteLines: string[];
}

export interface MergeResult {
  /** Merged lines (contains conflict markers when `clean` is false). */
  mergedLines: string[];
  merged: string;
  clean: boolean;
  conflicts: MergeConflict[];
}

const CONFLICT_START = '<<<<<<<';
const CONFLICT_MIDDLE = '=======';
const CONFLICT_END = '>>>>>>>';

// ---------------------------------------------------------------------------
// Myers O(ND) line diff → change hunks (base coordinates)
// ---------------------------------------------------------------------------

/**
 * Compute the shortest-edit-script diff between two line arrays using the
 * Myers algorithm, then collapse it into maximal change hunks expressed in
 * base coordinates with their replacement text.
 */
export function diffHunks(a: string[], b: string[]): DiffHunk[] {
  const n = a.length;
  const m = b.length;
  if (n === 0) {
    return b.length > 0 ? [{ baseStart: 0, baseEnd: 0, lines: [...b] }] : [];
  }
  if (m === 0) {
    return [{ baseStart: 0, baseEnd: n, lines: [] }];
  }

  const max = n + m;
  const offset = max;
  const v = new Int32Array(2 * max + 1);
  const trace: Int32Array[] = [];
  let dFound = -1;

  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      const index = k + offset;
      let x: number;
      if (k === -d || (k !== d && v[index - 1] < v[index + 1])) {
        x = v[index + 1];
      } else {
        x = v[index - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[index] = x;
      if (x >= n && y >= m) {
        dFound = d;
        break outer;
      }
    }
  }

  if (dFound === -1) {
    // Defensive: treat whole file as replaced.
    return [{ baseStart: 0, baseEnd: n, lines: [...b] }];
  }

  interface EditOp {
    type: 'eq' | 'del' | 'ins' | 'repl';
    aStart: number;
    aEnd: number;
    bStart: number;
    bEnd: number;
  }
  const ops: EditOp[] = [];
  let x = n;
  let y = m;
  for (let d = dFound; d > 0; d--) {
    const vPrev = trace[d];
    const k = x - y;
    const index = k + offset;
    let prevK: number;
    if (k === -d || (k !== d && vPrev[index - 1] < vPrev[index + 1])) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = vPrev[prevK + offset];
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      ops.unshift({ type: 'eq', aStart: x - 1, aEnd: x, bStart: y - 1, bEnd: y });
      x--;
      y--;
    }
    if (d > 0) {
      let opType: EditOp['type'];
      let aStart = prevX;
      let aEnd = prevX;
      let bStart = prevY;
      let bEnd = prevY;
      if (x === prevX) {
        opType = 'ins';
        bStart = prevY;
        bEnd = y;
      } else if (y === prevY) {
        opType = 'del';
        aStart = prevX;
        aEnd = x;
      } else {
        opType = 'repl';
        aStart = prevX;
        aEnd = x;
        bStart = prevY;
        bEnd = y;
      }
      ops.unshift({ type: opType, aStart, aEnd, bStart, bEnd });
      x = prevX;
      y = prevY;
    }
  }

  // Collapse ops into base-coordinate change hunks.
  const hunks: DiffHunk[] = [];
  let cur: DiffHunk | null = null;
  for (const op of ops) {
    if (op.type === 'eq') {
      cur = null;
      continue;
    }
    if (cur !== null && op.aStart === cur.baseEnd) {
      cur.baseEnd = op.aEnd;
      cur.lines.push(...b.slice(op.bStart, op.bEnd));
    } else {
      cur = { baseStart: op.aStart, baseEnd: op.aEnd, lines: b.slice(op.bStart, op.bEnd) };
      hunks.push(cur);
    }
  }
  return hunks;
}

// ---------------------------------------------------------------------------
// diff3 merge walk
// ---------------------------------------------------------------------------

function linesEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Merge `local` and `remote` against the common ancestor `base`.
 * Returns merged lines with git-style conflict markers when regions clash.
 */
export function threeWayMerge(
  base: string[],
  local: string[],
  remote: string[]
): MergeResult {
  const localHunks = diffHunks(base, local);
  const remoteHunks = diffHunks(base, remote);

  const baseLen = base.length;
  const localChanged = new Uint8Array(baseLen);
  const remoteChanged = new Uint8Array(baseLen);
  const localByStart = new Map<number, DiffHunk>();
  const remoteByStart = new Map<number, DiffHunk>();
  const usedL = new Set<DiffHunk>();
  const usedR = new Set<DiffHunk>();

  for (const h of localHunks) {
    for (let i = h.baseStart; i < h.baseEnd; i++) localChanged[i] = 1;
    localByStart.set(h.baseStart, h);
  }
  for (const h of remoteHunks) {
    for (let i = h.baseStart; i < h.baseEnd; i++) remoteChanged[i] = 1;
    remoteByStart.set(h.baseStart, h);
  }

  const out: string[] = [];
  const conflicts: MergeConflict[] = [];

  const peek = (map: Map<number, DiffHunk>, used: Set<DiffHunk>, pos: number): DiffHunk | null => {
    const h = map.get(pos);
    return h !== undefined && !used.has(h) ? h : null;
  };
  const overlappingRemote = (start: number, end: number): DiffHunk[] =>
    remoteHunks.filter((h) => h.baseStart < end && h.baseEnd > start && !usedR.has(h));

  let i = 0;
  while (i <= baseLen) {
    // ---- Pure insertions at position i (do NOT consume base lines) ----
    const insL = peek(localByStart, usedL, i);
    const insR = peek(remoteByStart, usedR, i);
    if ((insL !== null && insL.baseEnd === i) || (insR !== null && insR.baseEnd === i)) {
      if (insL !== null && insR !== null) {
        if (linesEqual(insL.lines, insR.lines)) {
          out.push(...insL.lines);
        } else {
          conflicts.push({ baseStart: i, baseEnd: i, localLines: insL.lines, remoteLines: insR.lines });
          out.push(CONFLICT_START, ...insL.lines, CONFLICT_MIDDLE, ...insR.lines, CONFLICT_END);
        }
        usedL.add(insL);
        usedR.add(insR);
      } else if (insL !== null) {
        out.push(...insL.lines);
        usedL.add(insL);
      } else if (insR !== null) {
        out.push(...insR.lines);
        usedR.add(insR);
      }
      // Fall through: base[i] (if any and unchanged) must still be emitted.
    }

    if (i >= baseLen) break;

    // ---- Replacement hunks starting at i (consume base lines) ----
    const lh = peek(localByStart, usedL, i);
    const rh = peek(remoteByStart, usedR, i);

    if (lh !== null && rh !== null) {
      if (linesEqual(lh.lines, rh.lines)) {
        out.push(...lh.lines);
      } else {
        conflicts.push({
          baseStart: i,
          baseEnd: Math.max(lh.baseEnd, rh.baseEnd),
          localLines: lh.lines,
          remoteLines: rh.lines,
        });
        out.push(CONFLICT_START, ...lh.lines, CONFLICT_MIDDLE, ...rh.lines, CONFLICT_END);
      }
      usedL.add(lh);
      usedR.add(rh);
      i = Math.max(lh.baseEnd, rh.baseEnd);
      continue;
    }

    if (lh !== null) {
      const remoteOverlap = overlappingRemote(i, lh.baseEnd);
      if (remoteOverlap.length === 0) {
        out.push(...lh.lines);
        usedL.add(lh);
        i = lh.baseEnd;
        continue;
      }
      // Both sides changed overlapping (but not identically-started) regions →
      // real conflict. Remote side may have several hunks; join their text.
      const remoteLines: string[] = [];
      for (const r of remoteOverlap) remoteLines.push(...r.lines);
      conflicts.push({
        baseStart: i,
        baseEnd: Math.max(lh.baseEnd, ...remoteOverlap.map((r) => r.baseEnd)),
        localLines: lh.lines,
        remoteLines,
      });
      out.push(CONFLICT_START, ...lh.lines, CONFLICT_MIDDLE, ...remoteLines, CONFLICT_END);
      usedL.add(lh);
      for (const r of remoteOverlap) usedR.add(r);
      i = Math.max(lh.baseEnd, ...remoteOverlap.map((r) => r.baseEnd));
      continue;
    }

    if (rh !== null) {
      const localOverlap = localHunks.filter((h) => h.baseStart < rh.baseEnd && h.baseEnd > i && !usedL.has(h));
      if (localOverlap.length === 0) {
        out.push(...rh.lines);
        usedR.add(rh);
        i = rh.baseEnd;
        continue;
      }
      const localLines: string[] = [];
      for (const l of localOverlap) localLines.push(...l.lines);
      conflicts.push({
        baseStart: i,
        baseEnd: Math.max(rh.baseEnd, ...localOverlap.map((l) => l.baseEnd)),
        localLines,
        remoteLines: rh.lines,
      });
      out.push(CONFLICT_START, ...localLines, CONFLICT_MIDDLE, ...rh.lines, CONFLICT_END);
      usedR.add(rh);
      for (const l of localOverlap) usedL.add(l);
      i = Math.max(rh.baseEnd, ...localOverlap.map((l) => l.baseEnd));
      continue;
    }

    // ---- Unchanged base line ----
    out.push(base[i]);
    i++;
  }

  return {
    mergedLines: out,
    merged: out.join('\n'),
    clean: conflicts.length === 0,
    conflicts,
  };
}

/**
 * Convenience wrapper over line arrays.
 */
export function mergeTexts(base: string, local: string, remote: string): MergeResult {
  const toLines = (text: string): string[] => (text.length === 0 ? [] : text.split(/\r?\n/));
  return threeWayMerge(toLines(base), toLines(local), toLines(remote));
}

// ---------------------------------------------------------------------------
// Conflict resolution suggestion (LLM-backed with deterministic fallback)
// ---------------------------------------------------------------------------

export interface MergeSuggestion {
  /** Recommended merged value ('' when no sensible automatic pick). */
  resolution: string;
  /** Why this resolution was chosen. */
  reasoning: string;
  /** True when the suggestion came from an LLM provider. */
  llmGenerated: boolean;
}

export interface MergeSuggestionProvider {
  isAvailable(): boolean;
  analyze(prompt: string, systemPrompt?: string, temperature?: number): Promise<{ content: string }>;
}

/**
 * Produce a resolution suggestion for a conflicted merge.
 *
 * When an LLM provider is supplied AND reports availability, the provider is
 * asked to synthesize a resolution combining both sides' intent. Without a
 * provider (or on provider failure) a deterministic heuristic is used:
 * keep the LOCAL (stored) side and append the remote side's conflicting lines
 * as a clearly-marked "see also" block — never silently dropping either side.
 */
export async function buildMergeSuggestion(
  base: string,
  local: string,
  remote: string,
  conflicts: MergeConflict[],
  provider?: MergeSuggestionProvider | null
): Promise<MergeSuggestion> {
  if (conflicts.length > 0 && provider && provider.isAvailable()) {
    try {
      const system = [
        'You resolve concurrent-write conflicts in shared team-memory documents.',
        'Merge BOTH intents — never discard a side. Return ONLY the final merged text, no commentary, no markers.',
      ].join('\n');
      const prompt = [
        '## Base (common ancestor)',
        base,
        '',
        '## Local (currently stored)',
        local,
        '',
        '## Remote (incoming value)',
        remote,
        '',
        '## Conflicting regions (base line ranges)',
        ...conflicts.map((c) => `- lines ${c.baseStart}-${c.baseEnd}`),
        '',
        'Produce the merged document:',
      ].join('\n');
      const response = await provider.analyze(prompt, system, 0.2);
      const resolution = response.content.trim();
      if (resolution.length > 0) {
        return {
          resolution,
          reasoning: 'LLM provider synthesized a merged value preserving both sides.',
          llmGenerated: true,
        };
      }
    } catch {
      // Fall through to the deterministic heuristic.
    }
  }

  if (conflicts.length === 0) {
    const merged = mergeTexts(base, local, remote);
    return {
      resolution: merged.merged,
      reasoning: 'No conflicting regions — clean 3-way merge.',
      llmGenerated: false,
    };
  }

  const keptLocal = local.length > 0 ? local : base;
  const remoteOmitted = conflicts
    .map((c, idx) => `[conflict ${idx + 1} remote@${c.baseStart}-${c.baseEnd}]\n${c.remoteLines.join('\n')}`)
    .join('\n');
  return {
    resolution: `${keptLocal}\n\n<!-- UNMERGED REMOTE (resolve via retain/merge) -->\n${remoteOmitted}`,
    reasoning:
      'Conflict detected: both writers changed overlapping regions. Deterministic fallback: kept stored (local) value and appended the conflicting remote lines as a marked block — no data is silently dropped.',
    llmGenerated: false,
  };
}

// ---------------------------------------------------------------------------
// Team memory store contract (3-way merge over team_memories.base_value)
// ---------------------------------------------------------------------------

/**
 * What happened during a team-memory write:
 *  - 'stored'   — value written verbatim (insert, idempotent no-op, or
 *                 fast-forward where the stored copy was stale).
 *  - 'merged'   — clean 3-way merge: both sides changed disjoint regions and
 *                 the combined result was persisted.
 *  - 'conflict' — overlapping changes; the stored value was KEPT untouched
 *                 (never last-write-wins) and the caller surfaces the
 *                 suggestion for a human/agent decision.
 */
export type TeamMemoryStoreStatus = 'stored' | 'merged' | 'conflict';

export interface ExistingTeamMemoryRow {
  value: string;
  /** base_value recorded for the current value (null for freshly inserted rows). */
  baseValue: string | null;
}

/** Shared read-model for a team_memories row, incl. the 3-way-merge ancestor. */
export interface TeamMemoryRowView {
  id: number;
  agentName: string;
  scope: string;
  key: string;
  value: string;
  baseValue: string | null;
  isPublic: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TeamMemoryStoreComputation {
  status: TeamMemoryStoreStatus;
  /**
   * Value that should be persisted after the write decision:
   * incoming for stored/merged, the untouched previous value for conflict.
   */
  storedValue: string;
  /** Value that was current before this write ('' for a fresh insert). */
  previousValue: string;
  /** Merged output — contains conflict markers exactly when status === 'conflict'. */
  mergedValue: string;
  conflicts: MergeConflict[];
  /**
   * The base used for the merge (existing.base_value ?? previous value).
   * Recomputable by callers for suggestion text when a conflict occurred.
   */
  baseValueUsed: string;
  /** base_value to persist AFTER this write (null on insert). */
  nextBaseValue: string | null;
  /** true when the caller must issue an INSERT/UPDATE; false for no-op/conflict. */
  shouldWrite: boolean;
}

/**
 * Pure (DB-free) write decision for a team-memory upsert.
 *
 * Replaces last-write-wins so concurrent agents editing the same memory key
 * never silently clobber each other:
 *   existing == null                → plain insert              (stored)
 *   existing.value == incoming      → idempotent no-op          (stored, no write)
 *   existing.value == base          → fast-forward incoming     (stored)
 *   clean diff3(base, local, incoming) → persist the merge      (merged)
 *   conflicting diff3               → keep stored, no write     (conflict)
 */
export function computeTeamMemoryStore(
  existing: ExistingTeamMemoryRow | null,
  incoming: string
): TeamMemoryStoreComputation {
  if (existing === null) {
    return {
      status: 'stored',
      storedValue: incoming,
      previousValue: '',
      mergedValue: incoming,
      conflicts: [],
      baseValueUsed: '',
      nextBaseValue: null,
      shouldWrite: true,
    };
  }

  const local = existing.value;
  const base = existing.baseValue ?? existing.value;

  if (local === incoming) {
    return {
      status: 'stored',
      storedValue: local,
      previousValue: local,
      mergedValue: local,
      conflicts: [],
      baseValueUsed: base,
      nextBaseValue: existing.baseValue,
      shouldWrite: false,
    };
  }

  const merge = mergeTexts(base, local, incoming);

  if (!merge.clean) {
    return {
      status: 'conflict',
      storedValue: local,
      previousValue: local,
      mergedValue: merge.merged,
      conflicts: merge.conflicts,
      baseValueUsed: base,
      nextBaseValue: existing.baseValue,
      shouldWrite: false,
    };
  }

  if (merge.merged === local) {
    // Remote made no net change (e.g. remote === base): nothing new to apply.
    return {
      status: 'stored',
      storedValue: local,
      previousValue: local,
      mergedValue: local,
      conflicts: [],
      baseValueUsed: base,
      nextBaseValue: existing.baseValue,
      shouldWrite: false,
    };
  }

  if (merge.merged === incoming) {
    // Fast-forward: the stored copy is exactly the base (stale), take incoming.
    return {
      status: 'stored',
      storedValue: incoming,
      previousValue: local,
      mergedValue: incoming,
      conflicts: [],
      baseValueUsed: base,
      nextBaseValue: local,
      shouldWrite: true,
    };
  }

  return {
    status: 'merged',
    storedValue: merge.merged,
    previousValue: local,
    mergedValue: merge.merged,
    conflicts: [],
    baseValueUsed: base,
    nextBaseValue: local,
    shouldWrite: true,
  };
}