/**
 * User Context Assembler v1.
 *
 * Ranks which files an agent should look at NEXT to a target file,
 * combining structural signals already present in the knowledge graph:
 *
 *   1. Direct dependents          — who imports this file (breaks first)
 *   2. Transitive dependents      — the blast radius closure
 *   3. Tests                      — test/spec files inside that closure
 *   4. Semantic neighbors         — embedding similarity (same purpose)
 *   5. Task keywords              — lexical match against candidate paths
 *                                   (cheap task inference; no LLM needed)
 *   6. Recent agent activity      — small boost for currently-worked files
 *
 * Output is a token-budget-capped ranked list WITH per-item reasons so the
 * consuming agent can judge trust, not just order.
 */

export interface UserContextItem {
  path: string;
  score: number;
  reasons: string[];
}

export interface UserContextResult {
  task: string | null;
  items: UserContextItem[];
  consideredFiles: number;
  note: string;
}

const MAX_TOKENS_PER_ITEM = 90; // ~chars reserved per serialized entry

export function assembleUserContext(
  kg: import('../../storage/knowledge-graph.js').KnowledgeGraph,
  options: {
    fileId: number;
    relativePath: string;
    cognitiveLoad: number;
    task?: string;
    maxTokens?: number;
    limit?: number;
  }
): UserContextResult {
  const { fileId } = options;

  // ---- Candidate pools -------------------------------------------------
  const scores = new Map<number, { info: import('../../storage/kg/types.js').FileInfo; score: number; reasons: Set<string> }>();
  const consider = (info: import('../../storage/kg/types.js').FileInfo, points: number, reason: string): void => {
    if (info.id === fileId) return; // the target itself is not a suggestion
    let entry = scores.get(info.id);
    if (!entry) {
      entry = { info, score: 0, reasons: new Set() };
      scores.set(info.id, entry);
    }
    entry.score += points;
    entry.reasons.add(reason);
  };

  // 1+2. Dependents: direct then transitive via graph engine (reverse BFS).
  let considered = 0;
  try {
    const g = kg.getGraphTraversal(false); // cached adjacency OK here
    const radius = g.getImpactRadius(fileId);

    // Split affected set into direct vs transitive using direct count.
    const affected = radius.affected;
    considered += affected.length;
    const directIds = new Set<string>();
    // Rebuild direct set cheaply from reverse adjacency through a 1-hop BFS.
    const oneHop = g.bfs(fileId, 1, false);
    for (const n of oneHop.visited) {
      if (n.id !== fileId) directIds.add(String(n.id));
    }

    for (const node of affected) {
      // GraphNode lacks FileInfo fields (sizeBytes etc.) — synthesize a
      // minimal FileInfo-compatible object from what we have.
      const pseudoInfo = {
        id: node.id,
        path: node.path,
        relativePath: node.relativePath,
        language: node.language,
        cognitiveLoad: node.cognitiveLoad,
        agentTouched: node.agentTouched,
        agentTouchedBy: node.agentTouchedBy,
      } as import('../../storage/kg/types.js').FileInfo;
      const isDirect = directIds.has(String(node.id));
      consider(pseudoInfo, isDirect ? 0.5 : 0.28, isDirect ? 'direct-dependent' : 'in-blast-radius');
    }
  } catch {
    // graph engine unavailable → fall back to plain dependents list
    for (const d of kg.getDependents(fileId)) {
      consider(d, 0.5, 'direct-dependent');
      considered++;
    }
  }

  // 3. Semantic neighbors via stored embeddings.
  try {
    const emb = kg.getFileEmbedding?.(fileId) ?? null;
    if (emb && emb.length > 0) {
      for (const sim of kg.findSimilarFiles(emb, 0.72, 10)) {
        consider(sim, 0.32, 'semantically-similar');
        considered++;
      }
    }
  } catch {
    // embeddings unavailable → skip silently, structural signals remain
  }

  // 4+5. Apply task-keyword boosts and test flags over the pooled set.
  const taskTokens = tokenize(options.task ?? '');
  for (const entry of scores.values()) {
    const rel = entry.info.relativePath || entry.info.path;
    if (options.task && isTestPath(rel)) {
      entry.score += 0.15;
      entry.reasons.add('test-file');
    }
    if (entry.info.agentTouched) {
      entry.score += 0.06;
      entry.reasons.add('recently-agent-touched');
    }
    if (taskTokens.size > 0) {
      const hay = `${rel} ${rel.split(/[\\/]/).pop() ?? ''}`.toLowerCase();
      let hits = 0;
      for (const tok of taskTokens) {
        if (hay.includes(tok)) hits++;
      }
      if (hits > 0) {
        entry.score += Math.min(0.25, hits * 0.09);
        entry.reasons.add(`task-keyword:${hits}`);
      }
    }
  }

  // ---- Rank + token-budget cap ----------------------------------------
  const ranked = [...scores.entries()]
    .map(([, e]) => ({
      path: e.info.relativePath || e.info.path,
      score: Math.round(Math.min(1, e.score) * 1000) / 1000,
      reasons: [...e.reasons],
      load: e.info.cognitiveLoad,
    }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  let cap = options.limit ?? 8;
  if (options.maxTokens !== undefined && options.maxTokens > 0) {
    const budgetItems = Math.floor((options.maxTokens * 4) / MAX_TOKENS_PER_ITEM);
    cap = Math.max(1, Math.min(cap, budgetItems));
  }

  const items: UserContextItem[] = ranked.slice(0, cap).map(({ path, score, reasons }) => ({ path, score, reasons }));

  return {
    task: options.task?.trim() || null,
    items,
    consideredFiles: considered,
    note:
      'Heuristic ranking (no LLM): higher score = look at this file sooner. Reasons explain WHY each file is suggested.',
  };
}

const isTestPath = (p: string): boolean =>
  /(^|\/)(tests?|__tests__)\//.test(p) || /\.(test|spec)\.[a-z]+$/i.test(p);

function tokenize(task: string): Set<string> {
  return new Set(
    task
      .toLowerCase()
      .split(/[^a-z0-9_-]+/)
      .filter((t) => t.length >= 3)
  );
}