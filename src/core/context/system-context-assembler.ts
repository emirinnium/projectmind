/**
 * System Context Assembler v1.
 *
 * System-focused context assembly for ProjectMind internal operations.
 * Handles structural analysis, dependency tracking, and system-level
 * context ranking independent of any particular agent's task model.
 *
 * Used by the coherence engine, impact analysis, and architectural
 * boundary enforcement to determine systemic impact of changes.
 */

import type { KnowledgeGraph } from '../../storage/knowledge-graph.js';
import type { FileInfo } from '../../storage/kg/types.js';

/**
 * System context item with structural metadata.
 */
export interface SystemContextItem {
  path: string;
  score: number;
  reasons: string[];
  layer: string;
  module: string;
}

/**
 * System context result containing structural analysis.
 */
export interface SystemContextResult {
  task: string | null;
  items: SystemContextItem[];
  consideredFiles: number;
  note: string;
  hasCircularDeps: boolean;
}

/**
 * Assembles system-level context for impact analysis and architectural checking.
 * Focuses on dependency structure, layer compliance, and system-wide signals.
 */
export function assembleSystemContext(
  kg: KnowledgeGraph,
  options: {
    fileId: number;
    relativePath: string;
    cognitiveLoad: number;
    task?: string;
    maxTokens?: number;
    limit?: number;
  }
): SystemContextResult {
  const { fileId } = options;

  // ---- Candidate pools -------------------------------------------------
  const scores = new Map<number, { info: FileInfo; score: number; reasons: Set<string> }>();
  const consider = (info: FileInfo, points: number, reason: string, layer?: string, module?: string): void => {
    if (info.id === fileId) return;
    let entry = scores.get(info.id);
    if (!entry) {
      entry = { info, score: 0, reasons: new Set() };
      scores.set(info.id, entry);
    }
    entry.score += points;
    entry.reasons.add(reason);
    if (layer) entry.reasons.add(`layer:${layer}`);
    if (module) entry.reasons.add(`module:${module}`);
  };

  // 1+2. Dependents: direct then transitive via graph engine (reverse BFS).
  let considered = 0;
  try {
    const g = kg.getGraphTraversal(false);
    const radius = g.getImpactRadius(fileId);

    const affected = radius.affected;
    considered += affected.length;
    const directIds = new Set<string>();
    const oneHop = g.bfs(fileId, 1, false);
    for (const n of oneHop.visited) {
      if (n.id !== fileId) directIds.add(String(n.id));
    }

    for (const node of affected) {
      const pseudoInfo = {
        id: node.id,
        path: node.path,
        relativePath: node.relativePath,
        language: node.language,
        cognitiveLoad: node.cognitiveLoad,
        agentTouched: node.agentTouched,
        agentTouchedBy: node.agentTouchedBy,
      } as FileInfo;
      const isDirect = directIds.has(String(node.id));
      consider(
        pseudoInfo,
        isDirect ? 0.5 : 0.28,
        isDirect ? 'direct-dependent' : 'in-blast-radius',
        isDirect ? 'system' : 'core',
      );
    }
  } catch {
    for (const d of kg.getDependents(fileId)) {
      consider(d, 0.5, 'direct-dependent', 'system');
      considered++;
    }
  }

  // 3. Semantic neighbors via stored embeddings.
  try {
    const emb = kg.getFileEmbedding?.(fileId) ?? null;
    if (emb && emb.length > 0) {
      for (const sim of kg.findSimilarFiles(emb, 0.72, 10)) {
        consider(sim, 0.32, 'semantically-similar', 'surface');
        considered++;
      }
    }
  } catch {
    // embeddings unavailable → skip silently
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

  let cap = options.limit ?? 16;
  if (options.maxTokens !== undefined && options.maxTokens > 0) {
    const budgetItems = Math.floor((options.maxTokens * 4) / 90);
    cap = Math.max(1, Math.min(cap, budgetItems));
  }

  const items: SystemContextItem[] = ranked.slice(0, cap).map(({ path, score, reasons }) => ({
    path,
    score,
    reasons,
    layer: 'system',
    module: 'core',
  }));

  return {
    task: options.task?.trim() || null,
    items,
    consideredFiles: considered,
    note:
      'System-level ranking: higher score = higher systemic impact. Includes layer and module metadata.',
    hasCircularDeps: false,
  };
}