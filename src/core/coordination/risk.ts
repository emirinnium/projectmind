import { reportSuppressedError } from '../../utils/errors.js';
import type { KnowledgeGraph } from '../../storage/knowledge-graph.js';

/** Maximum number of entries to track in the blast-radius closure before stopping. */
const RISK_ANALYSIS_CLOSURE_LIMIT = 2000;

/**
 * Merge-conflict prediction between agents (v1, graph-heuristic).
 *
 * Question answered: "I am about to edit these files; another agent holds
 * locks on those — how likely is it that our changes will collide?"
 *
 * Signal used (no git required): the blast-radius closure. If a file the
 * OTHER agent is holding sits inside the reverse-dependency closure of a
 * file I intend to change, our edits will very likely force changes on each
 * other's territory even though we never touched the same path.
 *
 * Honest scope: structural likelihood is always available. When both agents
 * provide content based on the same base, a bounded in-memory three-way
 * line-range comparison adds concrete conflict evidence; it does not pretend
 * to resolve AST or generated-file semantics.
 */

export interface ConflictRiskInput {
  /** Files I plan to edit (relative paths). */
  myFiles: string[];
  /** Files currently locked by OTHER agents (relative paths). */
  otherHeldFiles: string[];
  /** Optional proposed contents for a deterministic three-way comparison. */
  myContentChanges?: MergeContentChange[];
  /** Optional proposed contents for the other agent's changes. */
  otherContentChanges?: MergeContentChange[];
}

/** A proposed file version and the common content it was based on. */
export interface MergeContentChange {
  filePath: string;
  baseContent: string;
  proposedContent: string;
}

export interface MergeContentConflict {
  filePath: string;
  type: 'overlapping-edits' | 'inconsistent-base';
  detail: string;
  myRange?: { startLine: number; endLine: number };
  otherRange?: { startLine: number; endLine: number };
}

export interface MergeContentAnalysis {
  status: 'not-provided' | 'clean' | 'conflict' | 'unknown';
  method: 'none' | 'line-range-three-way';
  filesCompared: number;
  compatibleFiles: string[];
  conflicts: MergeContentConflict[];
  unknownFiles: Array<{ filePath: string; reason: string }>;
  limitations: string[];
}

export interface ConflictRisk {
  level: 'low' | 'medium' | 'high';
  score: number;
  /** Why this level: human-readable evidence lines. */
  reasons: string[];
  note: string;
  /** Detailed evidence when both agents provide common-base content. */
  contentAnalysis: MergeContentAnalysis;
}

export function predictMergeRisk(kg: KnowledgeGraph, input: ConflictRiskInput): ConflictRisk {
  const reasons: string[] = [];
  const mySet = new Set(input.myFiles.map(normalize));
  const heldSet = new Set(input.otherHeldFiles.map(normalize));

  // Direct overlap: we both target the same path (should not happen when
  // locks are respected, but belt-and-braces).
  let direct = 0;
  for (const f of mySet) {
    if (heldSet.has(f)) {
      direct++;
      reasons.push(`Direct collision: ${f} is locked by another agent AND in your edit list.`);
    }
  }

  // Closure overlap: their held files inside my blast radius (and vice versa).
  const g = kg.getGraphTraversal(false);
  const myClosure = new Map<string, string>(); // affectedPath -> rootCauseFile
  let unresolvedMine = 0;

  for (const f of mySet) {
    const info = kg.getFileByPath(f);
    if (!info) {
      unresolvedMine++;
      continue;
    }
    try {
      const radius = g.getImpactRadius(info.id);
      for (
        let i = 0;
        i < radius.affected.length && myClosure.size < RISK_ANALYSIS_CLOSURE_LIMIT;
        i++
      ) {
        const n = radius.affected[i];
        const p = normalize(n.relativePath || n.path);
        if (!myClosure.has(p)) myClosure.set(p, f);
      }
    } catch (error) {
      reportSuppressedError(error, 'Intentional fallback src/core/coordination/risk.ts:106');
      // graph engine unavailable → fall back to direct-only analysis
    }
  }

  let closureHits = 0;
  for (const held of heldSet) {
    if (mySet.has(held)) continue; // already reported as direct
    const cause = myClosure.get(held);
    if (cause) {
      closureHits++;
      reasons.push(
        `Blast-radius overlap: ${held} (locked by another agent) depends on your ${cause}.`,
      );
    }
  }

  // Reverse direction: I might be editing files inside THEIR blast radius —
  // approximated by checking whether my targets import their held files.
  let reverseHits = 0;
  for (const mine of mySet) {
    const info = kg.getFileByPath(mine);
    if (!info) continue;
    try {
      const oneHopImports = g.bfs(info.id, 1, true);
      for (const dep of oneHopImports.visited) {
        if (heldSet.has(normalize(dep.relativePath || dep.path))) {
          reverseHits++;
          reasons.push(
            `Shared dependency: your ${mine} imports ${[...heldSet].find((h) => h === normalize(dep.relativePath || dep.path))}.`,
          );
          break;
        }
      }
    } catch (error) {
      reportSuppressedError(error, 'Intentional fallback src/core/coordination/risk.ts:140');
      // ignore per-file failures
    }
  }

  const contentAnalysis = analyzeMergeContents(input.myContentChanges, input.otherContentChanges);
  for (const conflict of contentAnalysis.conflicts) {
    if (conflict.type === 'overlapping-edits') {
      reasons.push(`Content conflict: ${conflict.filePath} — ${conflict.detail}`);
    } else {
      reasons.push(`Content comparison unavailable: ${conflict.filePath} — ${conflict.detail}`);
    }
  }
  for (const unknown of contentAnalysis.unknownFiles) {
    reasons.push(`Content comparison unavailable: ${unknown.filePath} — ${unknown.reason}`);
  }

  const definiteContentConflicts = contentAnalysis.conflicts.filter(
    (conflict) => conflict.type === 'overlapping-edits',
  ).length;
  const uncertainContentFiles =
    contentAnalysis.unknownFiles.length +
    contentAnalysis.conflicts.filter((conflict) => conflict.type === 'inconsistent-base').length;
  const score =
    direct * 4 +
    closureHits * 2 +
    reverseHits +
    definiteContentConflicts * 4 +
    uncertainContentFiles;
  const level: ConflictRisk['level'] =
    definiteContentConflicts > 0 || score >= 4 ? 'high' : score >= 1 ? 'medium' : 'low';

  return {
    level,
    score,
    reasons,
    note:
      'Structural heuristic: blast-radius + dependency-direction analysis over the knowledge graph.' +
      (contentAnalysis.status === 'not-provided'
        ? ' No content-level comparison was provided.'
        : contentAnalysis.status === 'unknown'
          ? ' Content comparison was incomplete; inspect the reported limitations.'
          : ' Content-level three-way line-range comparison was performed.') +
      (unresolvedMine > 0
        ? ` ${unresolvedMine} of your files were not in the knowledge graph (unscanned).`
        : ''),
    contentAnalysis,
  };
}

interface LineEdit {
  /** Zero-based half-open range in the common base. */
  start: number;
  end: number;
  replacement: string[];
}

const MAX_CONTENT_CHARS = 200_000;
const MAX_DIFF_LINES = 3_000;
const MAX_DIFF_CELLS = 4_000_000;

/**
 * Compare two proposed versions against a shared base without writing files
 * or invoking git. A bounded LCS is deliberate: if input is too large, the
 * result is `unknown` instead of consuming unbounded memory or guessing.
 */
export function analyzeMergeContents(
  myChanges: MergeContentChange[] | undefined,
  otherChanges: MergeContentChange[] | undefined,
): MergeContentAnalysis {
  if (!myChanges || !otherChanges) {
    return {
      status: 'not-provided',
      method: 'none',
      filesCompared: 0,
      compatibleFiles: [],
      conflicts: [],
      unknownFiles: [],
      limitations: [
        'Content comparison requires both agents to provide baseContent and proposedContent for the same file.',
      ],
    };
  }

  const mine = new Map(myChanges.map((change) => [normalize(change.filePath), change]));
  const theirs = new Map(otherChanges.map((change) => [normalize(change.filePath), change]));
  const sharedPaths = [...mine.keys()].filter((filePath) => theirs.has(filePath)).sort();
  const compatibleFiles: string[] = [];
  const conflicts: MergeContentConflict[] = [];
  const unknownFiles: Array<{ filePath: string; reason: string }> = [];
  const limitations: string[] = [];

  for (const filePath of sharedPaths) {
    const mineChange = mine.get(filePath)!;
    const theirsChange = theirs.get(filePath)!;
    if (mineChange.baseContent !== theirsChange.baseContent) {
      conflicts.push({
        filePath,
        type: 'inconsistent-base',
        detail: 'the two proposals were based on different file contents',
      });
      continue;
    }

    if (mineChange.proposedContent === theirsChange.proposedContent) {
      compatibleFiles.push(filePath);
      continue;
    }

    const myEdits = getLineEdits(mineChange.baseContent, mineChange.proposedContent);
    const otherEdits = getLineEdits(mineChange.baseContent, theirsChange.proposedContent);
    if (!myEdits || !otherEdits) {
      unknownFiles.push({
        filePath,
        reason: `the bounded comparison limit was exceeded (${MAX_DIFF_LINES} lines or ${MAX_DIFF_CELLS} comparison cells)`,
      });
      continue;
    }

    const fileConflicts = findContentConflicts(filePath, myEdits, otherEdits);
    if (fileConflicts.length === 0) compatibleFiles.push(filePath);
    conflicts.push(...fileConflicts);
  }

  if (sharedPaths.length === 0) {
    limitations.push(
      'No file was supplied by both agents, so content-level overlap could not be evaluated.',
    );
  }
  if (mine.size !== sharedPaths.length || theirs.size !== sharedPaths.length) {
    limitations.push(
      'Only files supplied by both agents were compared; one-sided files require graph evidence.',
    );
  }
  if (unknownFiles.length > 0) {
    limitations.push('At least one file was too large for the bounded in-memory comparison.');
  }

  return {
    status: conflicts.some((conflict) => conflict.type === 'overlapping-edits')
      ? 'conflict'
      : unknownFiles.length > 0 ||
          conflicts.some((conflict) => conflict.type === 'inconsistent-base')
        ? 'unknown'
        : 'clean',
    method: 'line-range-three-way',
    filesCompared: sharedPaths.length,
    compatibleFiles,
    conflicts,
    unknownFiles,
    limitations,
  };
}

function getLineEdits(baseContent: string, proposedContent: string): LineEdit[] | null {
  if (baseContent.length > MAX_CONTENT_CHARS || proposedContent.length > MAX_CONTENT_CHARS)
    return null;
  const base = splitLines(baseContent);
  const proposed = splitLines(proposedContent);
  if (base.length > MAX_DIFF_LINES || proposed.length > MAX_DIFF_LINES) return null;
  if (base.length * proposed.length > MAX_DIFF_CELLS) return null;

  const width = proposed.length + 1;
  const table = Array.from({ length: base.length + 1 }, () => new Uint32Array(width));
  for (let i = base.length - 1; i >= 0; i--) {
    for (let j = proposed.length - 1; j >= 0; j--) {
      table[i][j] =
        base[i] === proposed[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const edits: LineEdit[] = [];
  let i = 0;
  let j = 0;
  while (i < base.length || j < proposed.length) {
    if (i < base.length && j < proposed.length && base[i] === proposed[j]) {
      i++;
      j++;
      continue;
    }
    const start = i;
    const replacement: string[] = [];
    while (i < base.length || j < proposed.length) {
      if (i < base.length && j < proposed.length && base[i] === proposed[j]) break;
      if (j < proposed.length && (i === base.length || table[i][j + 1] >= table[i + 1][j])) {
        replacement.push(proposed[j++]);
      } else {
        i++;
      }
    }
    edits.push({ start, end: i, replacement });
  }
  return edits;
}

function findContentConflicts(
  filePath: string,
  mine: LineEdit[],
  theirs: LineEdit[],
): MergeContentConflict[] {
  const conflicts: MergeContentConflict[] = [];
  for (const myEdit of mine) {
    for (const otherEdit of theirs) {
      if (!rangesOverlap(myEdit, otherEdit)) continue;
      if (
        myEdit.start === otherEdit.start &&
        myEdit.end === otherEdit.end &&
        arraysEqual(myEdit.replacement, otherEdit.replacement)
      ) {
        continue;
      }
      conflicts.push({
        filePath,
        type: 'overlapping-edits',
        detail: `different edits overlap base lines ${formatRange(myEdit)} and ${formatRange(otherEdit)}`,
        myRange: toDisplayRange(myEdit),
        otherRange: toDisplayRange(otherEdit),
      });
    }
  }
  return conflicts;
}

function rangesOverlap(a: LineEdit, b: LineEdit): boolean {
  const aInsertion = a.start === a.end;
  const bInsertion = b.start === b.end;
  if (aInsertion && bInsertion) return a.start === b.start;
  if (aInsertion) return a.start >= b.start && a.start <= b.end;
  if (bInsertion) return b.start >= a.start && b.start <= a.end;
  return a.start < b.end && b.start < a.end;
}

function toDisplayRange(edit: LineEdit): { startLine: number; endLine: number } {
  return { startLine: edit.start + 1, endLine: edit.end };
}

function formatRange(edit: LineEdit): string {
  const range = toDisplayRange(edit);
  return range.startLine === range.endLine
    ? `${range.startLine}`
    : `${range.startLine}-${range.endLine}`;
}

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((line, index) => line === b[index]);
}

function splitLines(content: string): string[] {
  return content.replace(/\r\n/g, '\n').split('\n');
}

function normalize(p: string): string {
  return p.split('\\').join('/');
}
