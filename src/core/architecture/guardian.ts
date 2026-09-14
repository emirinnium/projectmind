import {
  ContractEngine,
  type ArchitecturalContract,
  type ContractViolation,
} from '../contracts/engine.js';

export interface ArchitectureGuardianDecision {
  allowed: boolean;
  blocked: boolean;
  violations: ContractViolation[];
  nextActions: string[];
}

/**
 * Save-time architecture boundary. It evaluates source already read by the
 * watcher and never writes the file itself. Blocking is explicit opt-in.
 */
export class ArchitectureGuardian {
  private readonly engine: ContractEngine;

  constructor(
    contracts?: ArchitecturalContract[],
    private readonly blockOnError = false,
  ) {
    this.engine = new ContractEngine(contracts);
  }

  inspect(filePath: string, code: string): ArchitectureGuardianDecision {
    const violations = this.engine.evaluate(filePath.replace(/\\/g, '/'), code);
    const hasError = violations.some((violation) => violation.severity === 'error');
    const blocked = this.blockOnError && hasError;
    return {
      allowed: !blocked,
      blocked,
      violations,
      nextActions: blocked
        ? [
            'Fix the reported architecture contract violation(s) before the watcher accepts this update.',
            'Disable --guardian-block to keep diagnostics without blocking graph refresh.',
          ]
        : violations.length > 0
          ? ['Review the diagnostics and run the relevant contract or coherence checks.']
          : [],
    };
  }
}
