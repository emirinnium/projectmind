import { getStatement } from '../../../storage/database.js';
import { FileInfo } from '../../../storage/knowledge-graph.js';

export type DebtType = 'pattern_drift' | 'architectural_drift' | 'redundancy' | 'agent_conflict';
export type Severity = 'high' | 'medium' | 'low';

export interface DebtItem {
  id: number;
  type: DebtType;
  description: string;
  severity: Severity;
  suggestion: string;
  reasoningTrace: string[];
  detectedAt: string;
  resolved: boolean;
  filePath: string | null;
}

/**
 * Handles detection of architectural drift (circular dependencies)
 */
export class ArchitecturalDriftDetector {
  async detect(files: FileInfo[]): Promise<DebtItem[]> {
    const items: DebtItem[] = [];

    const importGraph = new Map<string, Set<string>>();
    for (const file of files) {
      const imports = getStatement(
        `SELECT source FROM imports JOIN files ON imports.file_id = files.id WHERE files.id = ?`
      ).all(file.id) as { source: string }[];
      importGraph.set(file.relativePath, new Set(imports.map((i: { source: string }) => i.source)));
    }

    const cyclicDeps = this.findCyclicDependencies(importGraph);
    for (const cycle of cyclicDeps) {
      items.push(this.createDebtItem({
        type: 'architectural_drift',
        description: `Circular dependency detected: ${cycle.join(' -> ')}`,
        severity: 'high',
        suggestion: 'Break the cycle by extracting shared logic into a separate module',
        reasoningTrace: [`Cycle: ${cycle.join(' -> ')}`],
        filePath: null,
      }));
    }

    return items;
  }

  private findCyclicDependencies(graph: Map<string, Set<string>>): string[][] {
    const cycles: string[][] = [];
    const visited = new Set<string>();
    const recStack = new Set<string>();
    const path: string[] = [];

    const dfs = (node: string) => {
      if (!graph.has(node)) return;
      visited.add(node);
      recStack.add(node);
      path.push(node);

      for (const dep of graph.get(node)!) {
        const depPath = dep.startsWith('.') ? dep : null;
        if (depPath && !visited.has(depPath)) {
          dfs(depPath);
        } else if (depPath && recStack.has(depPath)) {
          const cycleStart = path.indexOf(depPath);
          if (cycleStart >= 0) {
            cycles.push([...path.slice(cycleStart), depPath]);
          }
        }
      }

      path.pop();
      recStack.delete(node);
    };

    for (const node of graph.keys()) {
      if (!visited.has(node)) {
        dfs(node);
      }
    }

    return cycles;
  }

  private createDebtItem(opts: {
    type: DebtType;
    description: string;
    severity: Severity;
    suggestion: string;
    reasoningTrace: string[];
    filePath: string | null;
  }): DebtItem {
    return {
      id: 0,
      type: opts.type,
      description: opts.description,
      severity: opts.severity,
      suggestion: opts.suggestion,
      reasoningTrace: opts.reasoningTrace,
      detectedAt: new Date().toISOString(),
      resolved: false,
      filePath: opts.filePath,
    };
  }
}