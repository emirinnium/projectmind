import { collectGitChurn } from '@/cli/utils/git-churn.js';
import { loadConfig } from '@/cli/utils/shared.js';

export interface RefactorCandidate {
  file: string;
  module: string;
  type: 'extract-function' | 'extract-class' | 'inline' | 'rename' | 'move' | 'simplify';
  description: string;
  cognitiveLoad: number;
  churn: number;
  debtCount: number;
  coupling: number;
  estimatedEffortHours: number;
  riskReduction: number;
  frequency: number;
  roi: number;
  priority: 'critical' | 'high' | 'medium' | 'low';
  suggestion: string;
}

export interface FileInfoForRefactor {
  relativePath: string;
  path: string;
  cognitiveLoad: number;
  lines: number;
  agentTouched: boolean;
  imports?: Array<{ source: string }>;
  churn?: number;
}

export interface DebtReportForRefactor {
  items: Array<{
    filePath: string | null;
    type: string;
    severity: string;
    description: string;
    suggestion: string;
  }>;
}

export function generateRefactorCandidates(
  files: FileInfoForRefactor[],
  debtReport: DebtReportForRefactor,
): RefactorCandidate[] {
  const candidates: RefactorCandidate[] = [];
  // Real 90-day change frequency from git history; agent-touch fallback.
  const gitChurn = collectGitChurn(loadConfig().projectRoot, 90);
  // Second, shorter window feeds the acceleration (predictive) signal used
  // by createCandidate below (module-level so both scopes share it).
  recentChurnByFile = collectGitChurn(loadConfig().projectRoot, 30);

  for (const file of files) {
    const debtItems = debtReport.items.filter(
      (d) => d.filePath === file.relativePath || d.filePath === file.path,
    );
    const debtCount = debtItems.length;

    // Skip files with no debt and low cognitive load
    if (debtCount === 0 && file.cognitiveLoad < 0.2) continue;

    // Real change frequency from git history (falls back to agent-touch signal).
    const churn =
      gitChurn.get(String(file.relativePath).replace(/\\/g, '/'))?.count ??
      (file.agentTouched ? 1 : 0);

    // Calculate coupling (imports + imported by) - used in createCandidate
    const _coupling = Math.min(file.imports?.length || 0, 10) / 10;

    // Generate candidates based on file characteristics
    if (file.cognitiveLoad > 0.5 || file.lines > 300) {
      candidates.push(
        createCandidate(
          file,
          'extract-function',
          `Large function/file (${file.lines} lines, load: ${file.cognitiveLoad.toFixed(2)})`,
          Math.min(file.lines / 50, 8),
          0.3,
          churn,
          debtReport,
        ),
      );
    }

    if (file.cognitiveLoad > 0.7 && file.lines > 500) {
      candidates.push(
        createCandidate(
          file,
          'extract-class',
          `Large file with multiple responsibilities (${file.lines} lines)`,
          Math.min(file.lines / 100, 16),
          0.4,
          churn,
          debtReport,
        ),
      );
    }

    if (debtCount > 0) {
      const redundancyDebt = debtItems.filter((d) => d.type === 'redundancy');
      if (redundancyDebt.length > 0) {
        candidates.push(
          createCandidate(
            file,
            'simplify',
            `Code redundancy detected (${redundancyDebt.length} items)`,
            Math.min(redundancyDebt.length * 2, 8),
            0.35,
            churn,
            debtReport,
          ),
        );
      }

      const patternDrift = debtItems.filter((d) => d.type === 'pattern-drift');
      if (patternDrift.length > 0) {
        candidates.push(
          createCandidate(
            file,
            'rename',
            `Pattern drift detected - naming conventions violated`,
            Math.min(patternDrift.length, 4),
            0.25,
            churn,
            debtReport,
          ),
        );
      }
    }

    if (churn > 5 && file.cognitiveLoad > 0.3) {
      candidates.push(
        createCandidate(
          file,
          'move',
          `High churn file in wrong module - consider relocation`,
          4,
          0.3,
          churn,
          debtReport,
        ),
      );
    }

    if (file.lines < 50 && file.imports && file.imports.length > 5) {
      candidates.push(
        createCandidate(
          file,
          'inline',
          `Small file with many imports - consider inlining`,
          2,
          0.15,
          churn,
          debtReport,
        ),
      );
    }
  }

  return candidates;
}

/** Last-30d churn map shared with createCandidate for acceleration detection. */
let recentChurnByFile: Map<string, { count: number; authors: Set<string> }> | null = null;

function createCandidate(
  file: FileInfoForRefactor,
  type: RefactorCandidate['type'],
  description: string,
  effort: number,
  riskReduction: number,
  churn: number,
  debtReport: DebtReportForRefactor,
): RefactorCandidate {
  const frequency = churn;
  const roi = (riskReduction * frequency) / effort;

  // Predictive signal: is churn ACCELERATING? Compare last-30d against the
  // 90d window — a hot file heats up before it becomes a hotspot.
  let accelerating = false;
  if (recentChurnByFile) {
    const rel = file.relativePath.replace(/\\/g, '/');
    const c30 = recentChurnByFile.get(rel)?.count ?? 0;
    accelerating = churn > 2 && c30 >= Math.max(2, Math.ceil(churn * 0.6));
  }

  let suggestion = '';
  switch (type) {
    case 'extract-function':
      suggestion = 'Extract cohesive logic into separate functions to reduce cognitive load';
      break;
    case 'extract-class':
      suggestion = 'Split into multiple classes following Single Responsibility Principle';
      break;
    case 'simplify':
      suggestion = 'Remove duplicate code; extract shared utilities';
      break;
    case 'rename':
      suggestion = 'Align naming with project conventions';
      break;
    case 'move':
      suggestion = 'Move to more appropriate module to reduce coupling';
      break;
    case 'inline':
      suggestion = 'Inline small module into consumer to reduce indirection';
      break;
  }

  const debtItems = debtReport.items.filter(
    (d) => d.filePath === file.relativePath || d.filePath === file.path,
  );
  const debtCount = debtItems.length;
  const coupling = Math.min(file.imports?.length || 0, 10) / 10;

  return {
    file: file.relativePath,
    module: file.relativePath.split('/')[0] || 'root',
    type,
    description: accelerating ? `${description} ⏳ accelerating churn (30d vs 90d)` : description,
    cognitiveLoad: file.cognitiveLoad,
    churn: file.churn || 0,
    debtCount,
    coupling,
    estimatedEffortHours: Math.round(effort * 10) / 10,
    riskReduction,
    frequency: churn,
    roi: Math.round(((riskReduction * frequency) / effort) * 100) / 100,
    priority: roi > 3 ? 'critical' : roi > 1.5 ? 'high' : roi > 0.8 ? 'medium' : 'low',
    suggestion,
  };
}
