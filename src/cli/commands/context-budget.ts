import { Command } from 'commander';
import { withService, asyncHandler, output } from '@/cli/utils/shared.js';
import { writeFileSync } from 'node:fs';
import type { ScaleReport } from '../../core/scale/reporting/index.js';

interface ContextItem {
  file: string;
  relevance: number;
  tokens: number;
  type: 'file' | 'function' | 'class' | 'interface' | 'pattern' | 'debt' | 'test';
  summary: string;
  priority: number;
}

interface ContextBudgetResult {
  selected: ContextItem[];
  totalTokens: number;
  budget: number;
  utilization: number;
  strategy: string;
  excluded: ContextItem[];
  recommendations: string[];
}

export function createContextBudgetCommand(): Command {
  const budgetCmd = new Command('context-budget')
    .description('Optimize context window usage for AI agents')
    .argument('[task]', 'Task description for relevance scoring')
    .option('-b, --budget <tokens>', 'Token budget', '4000')
    .option('--strategy <strat>', 'Selection strategy: relevance|diversity|coverage|hybrid', 'hybrid')
    .option('--min-relevance <n>', 'Minimum relevance threshold (0-1)', '0.3')
    .option('--include-tests', 'Include test files', 'false')
    .option('--include-patterns', 'Include pattern summaries', 'true')
    .option('--include-debt', 'Include debt items', 'true')
    .option('--format <fmt>', 'Output: text|json|markdown', 'text')
    .option('-o, --output <file>', 'Write to file')
    .action(asyncHandler(async (task: string, opts: { budget: string; strategy: string; minRelevance: string; includeTests: string; includePatterns: string; includeDebt: string; format: string; output: string }) => {
      await withService(['scale', 'coherence'], async (_ctx, services) => {
        const scale = services.scale!;
        services.coherence!;
        
        output.section('Context Budget Optimizer');
        output.kv('Budget', `${opts.budget} tokens`);
        output.kv('Strategy', opts.strategy);
        output.kv('Task', task || 'general');
        
        const budget = parseInt(opts.budget, 10);
        parseFloat(opts.minRelevance);
        
        const report = scale.getScaleReport();
        report.modules.flatMap(m => m.files || []);
        
        // Build candidate context items
        const candidates = buildContextCandidates(task, report, {
          includeTests: opts.includeTests === 'true',
          includePatterns: opts.includePatterns === 'true',
          includeDebt: opts.includeDebt === 'true',
        });
        
        // Filter by relevance
        const filtered = candidates.filter(c => c.relevance >= parseFloat(opts.minRelevance));
        
        // Select within budget
        const result = selectWithinBudget(filtered, budget, opts.strategy);
        
        if (opts.format === 'json') {
          const content = JSON.stringify(result, null, 2);
          if (opts.output) {
            writeFileSync(opts.output, content);
            output.success(`Written to ${opts.output}`);
          } else {
            console.log(content);
          }
          return;
        }
        
        if (opts.format === 'markdown') {
          const content = generateMarkdownContextBudget(result, task);
          if (opts.output) {
            writeFileSync(opts.output, content);
            output.success(`Written to ${opts.output}`);
          } else {
            console.log(content);
          }
          return;
        }
        
        // Text format
        output.section(`Selected Context (~${result.totalTokens} tokens of ~${budget} budget, ${(result.utilization * 100).toFixed(1)}% used)`);
        output.info('Token counts are heuristic estimates (language-aware chars/token), not exact tokenizer output.');

        for (const [i, item] of result.selected.entries()) {
          const typeIcon = item.type === 'file' ? '📄' : item.type === 'function' ? '⚙️' : item.type === 'class' ? '📦' : item.type === 'interface' ? '📐' : item.type === 'pattern' ? '🔄' : item.type === 'debt' ? '💰' : '🧪';
          output.kv(`${i + 1}. ${typeIcon} ${item.file}`, `~${item.tokens} tokens | Relevance: ${(item.relevance * 100).toFixed(0)}% | ${item.summary}`);
        }
        
        output.section('Excluded (budget exceeded)');
        for (const item of result.excluded.slice(0, 10)) {
          output.kv(`  ${item.file}`, `${item.tokens} tokens | Relevance: ${(item.relevance * 100).toFixed(0)}%`);
        }
        
        if (result.recommendations.length > 0) {
          output.section('Recommendations');
          for (const rec of result.recommendations) {
            output.kv(`  💡 ${rec}`, '');
          }
        }
        
        if (opts.output) {
          writeFileSync(opts.output, JSON.stringify(result, null, 2));
          output.success(`Written to ${opts.output}`);
        }
      });
    }));
  
  return budgetCmd;
}

function buildContextCandidates(
  task: string,
  report: ScaleReport,
  options: { includeTests: boolean; includePatterns: boolean; includeDebt: boolean }
): ContextItem[] {
  const candidates: ContextItem[] = [];
  const allFiles = report.modules.flatMap(m => m.files || []);
  
  for (const file of allFiles) {
    if (!options.includeTests && file.relativePath.includes('.test.')) continue;
    
    const relevance = calculateRelevance(task, file);
    const tokens = estimateTokens(file);
    
    if (relevance > 0) {
      candidates.push({
        file: file.relativePath,
        relevance,
        tokens,
        type: 'file',
        summary: `${file.language} | ${file.sizeBytes}B | Load: ${file.cognitiveLoad.toFixed(2)}`,
        priority: relevance * (1 - file.cognitiveLoad),
      });
    }
  }
  
  if (options.includePatterns) {
    for (const module of report.modules) {
      candidates.push({
        file: `PATTERN: ${module.path}`,
        relevance: 0.7,
        tokens: 200,
        type: 'pattern',
        summary: `${module.fileCount} files | Load: ${module.cognitiveLoad.toFixed(2)}`,
        priority: 0.6,
      });
    }
  }
  
  if (options.includeDebt) {
    // Would integrate with debt tracker
  }
  
  return candidates;
}

function calculateRelevance(task: string, file: { relativePath: string; agentTouched: boolean; cognitiveLoad: number }): number {
  if (!task) return 0.5;
  
  const taskLower = task.toLowerCase();
  const fileLower = file.relativePath.toLowerCase();
  const fileName = fileLower.split('/').pop() || '';
  
  let relevance = 0;
  
  if (fileName.includes(taskLower) || taskLower.includes(fileName.replace('.ts', ''))) {
    relevance += 0.8;
  }
  
  const taskKeywords = taskLower.split(/\s+/).filter(w => w.length > 2);
  for (const kw of taskKeywords) {
    if (fileLower.includes(kw)) relevance += 0.3;
  }
  
  if (file.agentTouched) relevance += 0.2;
  relevance -= file.cognitiveLoad * 0.3;
  
  return Math.max(0, Math.min(1, relevance));
}

/**
 * Approximate token count. Source code is denser than prose (more symbols and
 * punctuation per token), so the chars/token ratio is language-aware:
 *   - code files: ~3.4 chars/token
 *   - everything else (docs/config prose): ~4.0 chars/token
 * This is a deliberate heuristic — NOT an exact tokenizer count. All user-facing
 * token numbers are prefixed with "~" to make the approximation explicit.
 */
const CODE_CHARS_PER_TOKEN = 3.4;
const PROSE_CHARS_PER_TOKEN = 4.0;
const CODE_LANGUAGES = new Set([
  'typescript', 'javascript', 'tsx', 'jsx', 'json',
  'python', 'go', 'rust', 'java', 'csharp', 'cpp', 'ruby',
]);

function estimateTokens(file: { sizeBytes: number; language?: string }): number {
  const ratio = file.language && CODE_LANGUAGES.has(file.language)
    ? CODE_CHARS_PER_TOKEN
    : PROSE_CHARS_PER_TOKEN;
  return Math.ceil(file.sizeBytes / ratio);
}

function selectWithinBudget(candidates: ContextItem[], budget: number, strategy: string): ContextBudgetResult {
  const selected: ContextItem[] = [];
  let totalTokens = 0;
  
  const sorted = [...candidates].sort((a, b) => {
    switch (strategy) {
      case 'relevance':
        return b.relevance - a.relevance;
      case 'diversity':
        return b.priority - a.priority;
      case 'coverage':
        return b.tokens - a.tokens; // Prefer smaller for more coverage
      case 'hybrid':
      default:
        return (b.relevance * 0.6 + b.priority * 0.4) - (a.relevance * 0.6 + a.priority * 0.4);
    }
  });
  
  for (const candidate of sorted) {
    if (totalTokens + candidate.tokens <= budget) {
      selected.push(candidate);
      totalTokens += candidate.tokens;
    }
  }
  
  const excluded = candidates.filter(c => !selected.includes(c));
  const utilization = totalTokens / budget;
  
  const recommendations: string[] = [];
  
  if (utilization < 0.5) {
    recommendations.push('Budget underutilized - consider increasing relevance threshold or adding more context');
  }
  if (utilization > 0.95) {
    recommendations.push('Budget nearly exhausted - consider increasing budget or using more aggressive filtering');
  }
  if (selected.length < 5 && candidates.length > 10) {
    recommendations.push('Few items selected - consider lowering min-relevance or using diversity strategy');
  }
  if (candidates.some(c => c.type === 'file' && c.tokens > budget * 0.5)) {
    recommendations.push('Some files exceed 50% of budget - consider summarizing large files');
  }
  
  return {
    selected,
    totalTokens,
    budget,
    utilization,
    strategy,
    excluded,
    recommendations,
  };
}

function generateMarkdownContextBudget(result: ContextBudgetResult, task: string): string {
  const lines = [
    `# Context Budget Report`,
    '',
    `**Task:** ${task || 'General'}`,
    `**Budget:** ${result.budget} tokens`,
    `**Strategy:** ${result.strategy}`,
    `**Selected:** ${result.selected.length} items (${result.totalTokens} tokens, ${(result.utilization * 100).toFixed(1)}% utilized)`,
    '',
    '## Selected Items',
    '',
    '| # | File | Type | Tokens | Relevance | Summary |',
    '|---|------|------|--------|-----------|---------|',
  ];
  
  for (const [i, item] of result.selected.entries()) {
    lines.push(`| ${i + 1} | \`${item.file}\` | ${item.type} | ${item.tokens} | ${(item.relevance * 100).toFixed(0)}% | ${item.summary} |`);
  }
  
  lines.push('', '## Excluded Items', '');
  for (const item of result.excluded.slice(0, 20)) {
    lines.push(`- \`${item.file}\` (${item.tokens} tokens, ${(item.relevance * 100).toFixed(0)}% relevance)`);
  }
  
  if (result.recommendations.length > 0) {
    lines.push('', '## Recommendations', '');
    for (const rec of result.recommendations) {
      lines.push(`- ${rec}`);
    }
  }
  
  return lines.join('\n');
}