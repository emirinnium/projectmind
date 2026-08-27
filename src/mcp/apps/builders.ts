import type { ScaleReport } from '../../core/scale/reporting/types.js';
import type { DebtReport } from '../../core/debt/detection/persistence.js';
import type { AppComponent } from './types.js';

/** Bar chart of the biggest modules by file count (max 10 for readability). */
export function buildModuleSizeChart(report: ScaleReport): AppComponent {
  const top = [...report.modules]
    .sort((a, b) => b.fileCount - a.fileCount)
    .slice(0, 10);
  return {
    kind: 'chart',
    chartType: 'bar',
    title: 'Module File Counts',
    options: {
      labels: top.map((m) => m.name || m.path || '.'),
      series: [{ name: 'files', data: top.map((m) => m.fileCount) }],
    },
  };
}

/** Pie chart of the language mix by file count. */
export function buildLanguageChart(report: ScaleReport): AppComponent {
  return {
    kind: 'chart',
    chartType: 'pie',
    title: 'Language Mix (files)',
    options: {
      data: Object.entries(report.languages).map(([name, v]) => ({ name, value: v.files })),
    },
  };
}

/** Bar chart of debt items by severity. */
export function buildDebtChart(report: DebtReport): AppComponent {
  return {
    kind: 'chart',
    chartType: 'bar',
    title: `Debt by Severity (${report.totalItems} items)`,
    options: {
      labels: ['high', 'medium', 'low'],
      series: [{ name: 'items', data: [report.bySeverity.high, report.bySeverity.medium, report.bySeverity.low] }],
    },
  };
}

/** Form used to trigger a (re)scan from the client UI. */
export function buildScanForm(defaults: { root?: string; full?: boolean } = {}): AppComponent {
  return {
    kind: 'form',
    title: 'Rescan Project',
    submitLabel: 'Scan',
    fields: [
      { name: 'root', label: 'Root', type: 'text', placeholder: defaults.root ?? '.', default: defaults.root ?? '.' },
      { name: 'full', label: 'Force full scan (ignore cache)', type: 'boolean', default: defaults.full ?? false },
    ],
  };
}

/** Markdown summary component for the genome score. */
export function buildGenomeSummary(score: number, genomeDataLength: number): AppComponent {
  return {
    kind: 'markdown',
    content: `**Genome score:** ${(score * 100).toFixed(1)}% — genome data: ${genomeDataLength} records.`,
  };
}