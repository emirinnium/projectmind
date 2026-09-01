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

    if (result.verdict === 'fail' || result.verdict === 'warn') {
      // Persist immediately so findings reach debt_items and every report.
      items.push(
        this.persistence.createDebtItem({
          type: 'pattern_drift',
          description: `Pattern inconsistency in ${file.relativePath}`,
          severity: result.verdict === 'fail' ? 'high' : 'medium',
          suggestion: result.suggestions.join('; '),
          reasoningTrace: result.reasoningTrace,
          filePath: file.path,
        }),
      );
    }

    return items;
  }
}
