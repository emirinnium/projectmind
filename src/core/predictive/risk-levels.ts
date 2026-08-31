import type { PredictedFailure } from './types.js';

/**
 * Risk level ordering for comparison.
 * Each level includes all higher levels (e.g., 'high' includes 'critical').
 */
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export const RISK_ORDER: Record<RiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export const VALID_RISK_LEVELS: readonly RiskLevel[] = ['low', 'medium', 'high', 'critical'];

export function isRiskAtOrAbove(risk: RiskLevel, threshold: RiskLevel): boolean {
  return RISK_ORDER[risk] >= RISK_ORDER[threshold];
}

export function isValidRiskLevel(value: string): value is RiskLevel {
  return VALID_RISK_LEVELS.includes(value as RiskLevel);
}

/** Determine the overall (highest) risk level from a set of levels. */
export function getOverallRiskLevel(levels: RiskLevel[]): RiskLevel {
  if (levels.includes('critical')) return 'critical';
  if (levels.includes('high')) return 'high';
  if (levels.includes('medium')) return 'medium';
  return 'low';
}

/**
 * Compute a risk level from predicted failures based on confidence and count.
 * Mirrors the logic previously inlined in ImpactPredictor.
 */
export function computeRiskLevel(failures: PredictedFailure[]): RiskLevel {
  const highConf = failures.filter(f => f.confidence >= 0.7).length;
  const criticalConf = failures.filter(f => f.confidence >= 0.9).length;
  const total = failures.length;
  if (criticalConf > 0 || total >= 20) return 'critical';
  if (highConf > 0 || total >= 10) return 'high';
  if (total >= 3) return 'medium';
  return 'low';
}
