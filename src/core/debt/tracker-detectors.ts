import type { DebtItem } from './detection/persistence.js';
import type { FileInfo } from '../../storage/knowledge-graph.js';
import type { GitChurnEntry } from './git-churn.js';
import { COGNITIVE_LOAD_THRESHOLD } from './index.js';

/**
 * Technical debt analysis detectors.
 * Extracted from the DebtTracker to reduce coupling and enable
 * independent testing of each detection strategy.
 */

/** Analyzer for technical debt metrics within a single file. */
export function analyzeTechnicalDebt(
  file: { path: string; relativePath: string; lastModified?: string; cognitiveLoad?: number },
  content: string,
  churn: Map<string, GitChurnEntry> = new Map()
): DebtItem[] {
  const items: DebtItem[] = [];
  const reasoningTrace: string[] = [];

  // 1. Complexity Analysis — count decision points inside function bodies.
  const complexFunctionNames: string[] = [];
  const funcBodyRe =
    /(?:function\s+([A-Za-z0-9_$]+)\s*\([^)]*\)\s*\{|([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z0-9_$]+)\s*=>\s*\{)([\s\S]*?)\n\}/g;
  let bodyMatch: RegExpExecArray | null;
  while ((bodyMatch = funcBodyRe.exec(content)) !== null) {
    const body = bodyMatch[3] ?? '';
    const decisionPoints =
      (body.match(/\b(?:if|for|while|case|catch)\b/g) ?? []).length +
      (body.match(/\?|\&\&|\|\|/g) ?? []).length;
    if (decisionPoints > 10) {
      complexFunctionNames.push(bodyMatch[1] ?? bodyMatch[2] ?? 'anonymous');
    }
  }

  if (complexFunctionNames.length > 0) {
    reasoningTrace.push(`High cyclomatic complexity detected in ${complexFunctionNames.length} functions`);
    items.push({
      id: 0,
      type: 'complexity',
      description: `High cyclomatic complexity in ${file.relativePath}`,
      severity: 'medium',
      suggestion: `Refactor complex functions into smaller, more manageable pieces`,
      reasoningTrace,
      detectedAt: new Date().toISOString(),
      resolved: false,
      filePath: file.path,
    });
  }

  // 2. Code Age Analysis
  if (file.lastModified) {
    const lastModified = new Date(file.lastModified).getTime();
    const now = Date.now();
    const ageInDays = (now - lastModified) / (1000 * 60 * 60 * 24);
    
    if (ageInDays > 365) {
      reasoningTrace.push(`File is ${Math.floor(ageInDays)} days old - potential legacy code`);
      items.push({
        id: 0,
        type: 'code_age',
        description: `Legacy code detected in ${file.relativePath} (${Math.floor(ageInDays)} days old)`,
        severity: 'low',
        suggestion: `Review for outdated patterns or dependencies`,
        reasoningTrace,
        detectedAt: new Date().toISOString(),
        resolved: false,
        filePath: file.path,
      });
    }
  }

  // 3. Cognitive Load Analysis — tiered scheme (consistent with architecture.ts and tracker-core.ts)
    if (file.cognitiveLoad) {
      if (file.cognitiveLoad > COGNITIVE_LOAD_THRESHOLD) {
        reasoningTrace.push(`High cognitive load detected (${file.cognitiveLoad})`);
        items.push({
          id: 0,
          type: "cognitive_load",
          description: `High cognitive load in ${file.relativePath} (${file.cognitiveLoad})`,
          severity: "high",
          suggestion: `Split file into smaller modules or simplify logic`,
          reasoningTrace,
          detectedAt: new Date().toISOString(),
          resolved: false,
          filePath: file.path,
        });
      } else if (file.cognitiveLoad > 0.4) {
        reasoningTrace.push(`Moderate cognitive load detected (${file.cognitiveLoad})`);
        items.push({
          id: 0,
          type: "cognitive_load",
          description: `Moderate cognitive load in ${file.relativePath} (${file.cognitiveLoad})`,
          severity: "medium",
          suggestion: `Consider refactoring to reduce complexity in ${file.relativePath}`,
          reasoningTrace,
          detectedAt: new Date().toISOString(),
          resolved: false,
          filePath: file.path,
        });
      }
    }
  // 4. Change Frequency Analysis
  const churnEntry = churn.get(file.relativePath.replace(/\\/g, '/'));
  if (churnEntry && churnEntry.count >= 10) {
    reasoningTrace.push(
      `File changed ${churnEntry.count} times in the last 90 days by ${churnEntry.authors.size} author(s)`
    );
    items.push({
      id: 0,
      type: 'change_frequency',
      description: `High change frequency in ${file.relativePath} (${churnEntry.count} commits in 90 days)`,
      severity: 'medium',
      suggestion: `Frequently changed files attract regressions — consider strengthening test coverage or stabilizing the interface`,
      reasoningTrace,
      detectedAt: new Date().toISOString(),
      resolved: false,
      filePath: file.path,
    });
  }

  return items;
}