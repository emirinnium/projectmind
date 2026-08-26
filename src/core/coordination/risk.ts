import type { KnowledgeGraph } from '../../storage/knowledge-graph.js';

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
 * Honest scope: structural likelihood only. Content-level diff simulation
 * (actual merge trial) is future work.
 */

export interface ConflictRiskInput {
  /** Files I plan to edit (relative paths). */
  myFiles: string[];
  /** Files currently locked by OTHER agents (relative paths). */
  otherHeldFiles: string[];
}

export interface ConflictRisk {
  level: 'low' | 'medium' | 'high';
  score: number;
  /** Why this level: human-readable evidence lines. */
  reasons: string[];
  note: string;
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
      for (let i = 0; i < radius.affected.length && myClosure.size < 2000; i++) {
        const n = radius.affected[i];
        const p = normalize(n.relativePath || n.path);
        if (!myClosure.has(p)) myClosure.set(p, f);
      }
    } catch {
      // graph engine unavailable → fall back to direct-only analysis
    }
  }

  let closureHits = 0;
  for (const held of heldSet) {
    if (mySet.has(held)) continue; // already reported as direct
    const cause = myClosure.get(held);
    if (cause) {
      closureHits++;
      reasons.push(`Blast-radius overlap: ${held} (locked by another agent) depends on your ${cause}.`);
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
          reasons.push(`Shared dependency: your ${mine} imports ${[...heldSet].find((h) => h === normalize(dep.relativePath || dep.path))}.`);
          break;
        }
      }
    } catch {
      // ignore per-file failures
    }
  }

  const score = direct * 4 + closureHits * 2 + reverseHits;
  const level: ConflictRisk['level'] = score >= 4 ? 'high' : score >= 1 ? 'medium' : 'low';

  return {
    level,
    score,
    reasons,
    note:
      'v1 structural heuristic: blast-radius + dependency-direction analysis over the knowledge graph. ' +
      'No content-level merge simulation yet.' +
      (unresolvedMine > 0 ? ` ${unresolvedMine} of your files were not in the knowledge graph (unscanned).` : ''),
  };
}

function normalize(p: string): string {
  return p.split('\\').join('/');
}
