import { getStatement } from '../../../storage/database.js';
import { FileInfo } from '../../../storage/knowledge-graph.js';
import type { DebtItem } from './persistence.js';

/**
 * Handles detection of architectural drift (circular dependencies).
 * Uses resolved_path edges recorded at scan time so cycles are detectable
 * for normal relative imports as well as path aliases.
 */
export class ArchitecturalDriftDetector {
  private persistence: {
    createDebtItem(opts: {
      type: 'architectural_drift';
      description: string;
      severity: 'high' | 'medium' | 'low';
      suggestion: string;
      reasoningTrace: string[];
      filePath: string | null;
    }): DebtItem;
  };

  constructor(persistence: ArchitecturalDriftDetector['persistence']) {
    this.persistence = persistence;
  }

  async detect(files: FileInfo[]): Promise<DebtItem[]> {
    const items: DebtItem[] = [];

    // Build the graph from RESOLVED import edges (relative_path -> relative_path).
    const fileByPath = new Set<string>();
    for (const file of files) {
      fileByPath.add(file.relativePath);
    }

    const graph = new Map<string, Set<string>>();
    for (const file of files) {
      const edges = getStatement(
        `SELECT resolved_path FROM imports WHERE file_id = ? AND resolved_path IS NOT NULL`,
      ).all(file.id) as Array<{ resolved_path: string }>;
      for (const { resolved_path } of edges) {
        // Only keep edges that land on known files (self-project edges).
        if (!fileByPath.has(resolved_path)) continue;
        if (!graph.has(file.relativePath)) graph.set(file.relativePath, new Set());
        graph.get(file.relativePath)!.add(resolved_path);
      }
    }

    for (const cycle of this.deduplicateCycles(this.findCycles(graph))) {
      // Persist immediately so findings reach debt_items and every report.
      // Dedupe also prevents rotated representations of the same cycle from
      // creating multiple debt rows within a single run.
      items.push(
        this.persistence.createDebtItem({
          type: 'architectural_drift',
          description: `Circular dependency detected: ${cycle.join(' -> ')}`,
          severity: 'high',
          suggestion: 'Break the cycle by extracting shared logic into a separate module',
          reasoningTrace: [`Cycle: ${cycle.join(' -> ')}`],
          filePath: null,
        }),
      );
    }

    return items;
  }

  /** Rotate each cycle so its lexicographically smallest node leads, then drop repeats. */
  private deduplicateCycles(cycles: string[][]): string[][] {
    const unique: string[][] = [];
    for (const cycle of cycles) {
      let minIdx = 0;
      for (let i = 1; i < cycle.length; i++) {
        if (cycle[i] < cycle[minIdx]) minIdx = i;
      }
      const normalized = [...cycle.slice(minIdx), ...cycle.slice(0, minIdx)];
      if (
        !unique.some(
          (u) => u.length === normalized.length && u.every((n, i) => n === normalized[i]),
        )
      ) {
        unique.push(normalized);
      }
    }
    return unique;
  }

  private findCycles(graph: Map<string, Set<string>>): string[][] {
    const cycles: string[][] = [];
    const visited = new Set<string>();
    const recStack = new Set<string>();
    const path: string[] = [];

    const dfs = (node: string): void => {
      if (!graph.has(node)) return;
      visited.add(node);
      recStack.add(node);
      path.push(node);

      for (const dep of graph.get(node)!) {
        if (!visited.has(dep)) {
          dfs(dep);
        } else if (recStack.has(dep)) {
          const cycleStart = path.indexOf(dep);
          if (cycleStart >= 0) {
            cycles.push([...path.slice(cycleStart), dep]);
          }
        }
      }

      path.pop();
      recStack.delete(node);
    };

    for (const node of graph.keys()) {
      if (!visited.has(node)) dfs(node);
    }

    return cycles;
  }
}
