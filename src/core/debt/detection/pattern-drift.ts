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
    // other heuristics). They remain visible through `check`, but they are
    // not architectural pattern violations and must not become blockers just
    // because several warnings occur in one file. A contract ERROR is the
    // only fast-tier result that is strong enough for high-severity debt.
    if (result.verdict === 'fail') {
      const hasContractError = result.reasoningTrace.some((trace) =>
        trace.startsWith('[Contract ERROR]'),
      );
      // Persist immediately so findings reach debt_items and every report.
      items.push(
        this.persistence.createDebtItem({
          type: 'pattern_drift',
          description: hasContractError
            ? `Architectural pattern violation in ${file.relativePath}`
            : `Coherence heuristics require review in ${file.relativePath}`,
          severity: hasContractError ? 'high' : 'low',
          suggestion: result.suggestions.join('; '),
          reasoningTrace: result.reasoningTrace,
          filePath: file.path,
        }),
      );
    }

    return items;
  }
}
