import type { DebtItemDTO } from '../../types/mcp-types.js';
import { logger } from '@/utils/logger.js';

export function formatGenomeScore(score: number): string {
  const pct = (score * 100).toFixed(1);
  let status = 'Poor';
  if (score >= 0.9) status = 'Excellent';
  else if (score >= 0.75) status = 'Good';
  else if (score >= 0.6) status = 'Fair';
  return `${pct}% — ${status}`;
}

export function formatDebtReport(report: {
  totalItems: number;
  bySeverity: Record<string, number>;
  coherenceGenomeScore: number;
  items: DebtItemDTO[];
}): string {
  const lines = [
    '=== Cognitive Debt Report ===',
    `Total items: ${report.totalItems}`,
    `High: ${report.bySeverity.high}`,
    `Medium: ${report.bySeverity.medium}`,
    `Low: ${report.bySeverity.low}`,
    `Genome score: ${formatGenomeScore(report.coherenceGenomeScore)}`,
  ];
  
  if (report.items.length > 0) {
    lines.push('\nDebt items:');
    for (const item of report.items) {
      lines.push(`\n[${item.severity.toUpperCase()}] ${item.type}`);
      lines.push(`  ${item.description}`);
      lines.push(`  File: ${item.filePath || 'project-wide'}`);
      if (item.suggestion) lines.push(`  Suggestion: ${item.suggestion}`);
    }
  } else {
    lines.push('\nNo cognitive debt found.');
  }
  
  return lines.join('\n');
}

export function handleCliError(error: unknown, context?: string): void {
  const message = error instanceof Error ? error.message : String(error);
  logger.error(`${context ? `${context}: ` : ''}${message}`);
  if (error instanceof Error && error.stack) {
    logger.debug(error.stack);
  }
  return;
}


export function asyncHandler<TArgs extends unknown[]>(
  fn: (...args: TArgs) => Promise<void>
): (...args: TArgs) => Promise<void> {
  return async (...args: TArgs) => {
    try {
      await fn(...args);
    } catch (error) {
      handleCliError(error);
      throw error;
    }
  };
}
