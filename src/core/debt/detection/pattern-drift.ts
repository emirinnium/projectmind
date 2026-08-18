import { FileInfo } from '../../../storage/knowledge-graph.js';
import { CoherenceEngine } from '../../coherence-engine.js';

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
 * Handles detection of pattern drift using coherence engine
 */
export class PatternDriftDetector {
  private coherenceEngine: CoherenceEngine;

  constructor(coherenceEngine: CoherenceEngine) {
    this.coherenceEngine = coherenceEngine;
  }

  async detect(file: FileInfo, content: string): Promise<DebtItem[]> {
    const items: DebtItem[] = [];

    const result = await this.coherenceEngine.checkCoherence({
      code: content,
      filePath: file.path,
      fastOnly: true,
    });

    if (result.verdict === 'fail' || result.verdict === 'warn') {
      items.push(this.createDebtItem({
        type: 'pattern_drift',
        description: `Pattern inconsistency in ${file.relativePath}`,
        severity: result.verdict === 'fail' ? 'high' : 'medium',
        suggestion: result.suggestions.join('; '),
        reasoningTrace: result.reasoningTrace,
        filePath: file.path,
      }));
    }

    return items;
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
      id: 0, // Will be set when persisted
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