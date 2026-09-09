import { FileInfo } from '../../../storage/knowledge-graph.js';
import { CoherenceEngine } from '../../coherence/engine.js';
import type { DebtItem } from './persistence.js';

export class PatternDriftDetector {
  private coherenceEngine: CoherenceEngine;
  private persistence: {
    createDebtItem(opts: {
      type: 'pattern_drift';
      description: string;
      severity: 'high' | 'medium' | 'low';
      suggestion: string;
      reasoningTrace: string[];
      filePath: string | null;
    }): DebtItem;
  };

  constructor(coherenceEngine: CoherenceEngine, persistence: PatternDriftDetector['persistence']) {
    this.coherenceEngine = coherenceEngine;
    this.persistence = persistence;
  }

  async detect(file: FileInfo, content: string): Promise<DebtItem[]> {
    const items: DebtItem[] = [];

    // Pattern consistency is a PRODUCT-code concern. Test scaffolding,
    // scripts and build output legitimately violate style heuristics
    // (console noise, loose typing in fixtures) and must not raise drift.
    if (!file.relativePath.replace(/\\/g, '/').startsWith('src/')) {
      return items;
    }

    const result = await this.coherenceEngine.checkCoherence({
      code: content,
      // Contract source patterns are project-relative globs (e.g.
      // 'src/cli/commands/**/*.ts'); passing the absolute path would
      // never match them, silently disabling contract-based detection.
      filePath: file.relativePath,
      fastOnly: true,
    });

    // Fast-tier warnings are advisory signals (file size, import count and
    // other heuristics). They remain visible through `check`, but are not
    // durable medium debt: one weak heuristic is not enough evidence for a
    // medium-severity finding. Only a failed coherence check becomes debt.
    if (result.verdict === 'fail') {
      // Persist immediately so findings reach debt_items and every report.
      items.push(
        this.persistence.createDebtItem({
          type: 'pattern_drift',
          description: `Pattern inconsistency in ${file.relativePath}`,
          severity: 'high',
          suggestion: result.suggestions.join('; '),
          reasoningTrace: result.reasoningTrace,
          filePath: file.path,
        }),
      );
    }

    return items;
  }
}
