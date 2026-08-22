import { Command } from 'commander';
import { withService, asyncHandler, output } from '@/cli/utils/shared.js';
import { loadConfig } from '@/cli/utils/shared.js';
import { writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

export function createChurnCommand(): Command {
  const churnCmd = new Command('churn')
    .description('Analyze code churn and risk hotspots')
    .option('--since <days>', 'Look back N days', '30')
    .option('--risk-threshold <n>', 'Risk threshold (0-1)', '0.7')
    .option('--by <type>', 'Group by: file|author|module', 'file')
    .option('--format <fmt>', 'Output: text|json|html', 'text')
    .option('-o, --output <file>', 'Write to file')
    .action(asyncHandler(async (opts: { since: string; riskThreshold: string; by: string; format: string; output: string }) => {
      await withService(['scale'], async (_ctx, services) => {
        const scale = services.scale!;
        const config = loadConfig();
        
        output.section('Code Churn & Risk Analysis');
        output.kv('Since', `${opts.since} days ago`);
        output.kv('Risk threshold', opts.riskThreshold);
        output.kv('Group by', opts.by);
        
        const report = scale.getScaleReport();
        const allFiles = report.modules.flatMap(m => m.files || []);
        
        // Simulate churn data from agent sessions (since we don't have git history)
        // In a real implementation, this would parse git log
        const churnData = calculateChurnFromSessions(allFiles, config.projectRoot, parseInt(opts.since, 10));
        
        const riskThreshold = parseFloat(opts.riskThreshold);
        const highRisk = churnData.filter(c => c.riskScore >= riskThreshold);
        
        if (opts.format === 'json') {
          const content = JSON.stringify({ churnData, highRisk, summary: { totalFiles: churnData.length, highRiskCount: highRisk.length } }, null, 2);
          if (opts.output) {
            writeFileSync(opts.output, content);
            output.success(`Written to ${opts.output}`);
          } else {
            console.log(content);
          }
          return;
        }
        
        if (opts.format === 'html') {
          const content = generateHtmlChurn(churnData, highRisk, riskThreshold);
          if (opts.output) {
            writeFileSync(opts.output, content);
            output.success(`Written to ${opts.output}`);
          } else {
            console.log(content);
          }
          return;
        }
        
        // Text format
        output.section(`Churn Analysis (${churnData.length} files tracked)`);
        
        if (opts.by === 'file') {
          // Sort by risk score
          const sorted = [...churnData].sort((a, b) => b.riskScore - a.riskScore);
          
          for (const item of sorted.slice(0, 30)) {
            const riskIcon = item.riskScore >= riskThreshold ? '🔴' : item.riskScore >= riskThreshold * 0.5 ? '🟡' : '🟢';
            const churnIcon = item.churnCount > 10 ? '🔄' : item.churnCount > 5 ? '🔁' : '➡️';
            output.kv(`${riskIcon} ${churnIcon} ${item.path}`, `Risk: ${(item.riskScore * 100).toFixed(1)}% | Churn: ${item.churnCount} | Load: ${item.cognitiveLoad.toFixed(3)} | Authors: ${item.authors.join(', ')}`);
          }
        } else if (opts.by === 'author') {
          const byAuthor = new Map<string, { files: number; totalRisk: number; totalChurn: number }>();
          for (const item of churnData) {
            for (const author of item.authors) {
              const existing = byAuthor.get(author) || { files: 0, totalRisk: 0, totalChurn: 0 };
              existing.files++;
              existing.totalRisk += item.riskScore;
              existing.totalChurn += item.churnCount;
              byAuthor.set(author, existing);
            }
          }
          
          for (const [author, data] of byAuthor) {
            const avgRisk = data.totalRisk / data.files;
            const icon = avgRisk >= riskThreshold ? '🔴' : avgRisk >= riskThreshold * 0.5 ? '🟡' : '🟢';
            output.kv(`${icon} ${author}`, `Files: ${data.files} | Avg Risk: ${(avgRisk * 100).toFixed(1)}% | Total Churn: ${data.totalChurn}`);
          }
        } else if (opts.by === 'module') {
          const byModule = new Map<string, { files: number; totalRisk: number; totalChurn: number }>();
          for (const item of churnData) {
            const mod = item.path.split('/')[0] || 'root';
            const existing = byModule.get(mod) || { files: 0, totalRisk: 0, totalChurn: 0 };
            existing.files++;
            existing.totalRisk += item.riskScore;
            existing.totalChurn += item.churnCount;
            byModule.set(mod, existing);
          }
          
          for (const [mod, data] of byModule) {
            const avgRisk = data.totalRisk / data.files;
            const icon = avgRisk >= riskThreshold ? '🔴' : avgRisk >= riskThreshold * 0.5 ? '🟡' : '🟢';
            output.kv(`${icon} ${mod}`, `Files: ${data.files} | Avg Risk: ${(avgRisk * 100).toFixed(1)}% | Total Churn: ${data.totalChurn}`);
          }
        }
        
        output.section('Summary');
        output.kv('Total files analyzed', churnData.length);
        output.kv('High-risk files', highRisk.length);
        output.kv('Max risk score', `${(Math.max(...churnData.map(c => c.riskScore)) * 100).toFixed(1)}%`);
        
        if (opts.output) {
          writeFileSync(opts.output, JSON.stringify({ churnData, highRisk }, null, 2));
          output.success(`Data written to ${opts.output}`);
        }
      });
    }));
  
  return churnCmd;
}

interface GitChurnEntry { count: number; authors: Set<string> }

/**
 * Parse real change frequency from `git log --name-only`.
 * Commit records start with an '@@<author>' sentinel followed by changed
 * file paths, so author lines and file lines can never be confused.
 */
function collectGitChurn(projectRoot: string, sinceDays: number): Map<string, GitChurnEntry> {
  const churn = new Map<string, GitChurnEntry>();
  try {
    const out = execSync(
      `git log --since="${sinceDays} days ago" --pretty=format:@@%an --name-only`,
      { cwd: projectRoot, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 }
    );
    let currentAuthor = 'unknown';
    for (const rawLine of out.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line.startsWith('@@')) {
        currentAuthor = line.slice(2) || 'unknown';
        continue;
      }
      const normalized = line.replace(/\\/g, '/');
      if (!normalized.includes('/')) continue; // skip stray non-path lines
      const entry = churn.get(normalized) ?? { count: 0, authors: new Set<string>() };
      entry.count += 1;
      entry.authors.add(currentAuthor);
      churn.set(normalized, entry);
    }
  } catch {
    // Not a git repo / git missing: callers fall back to agent-touch signals.
  }
  return churn;
}

function calculateChurnFromSessions(files: any[], projectRoot: string, sinceDays: number): any[] {
  const cutoff = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
  const gitChurn = collectGitChurn(projectRoot, sinceDays);
  const results = [];

  for (const file of files) {
    const normalizedPath = String(file.relativePath).replace(/\\/g, '/');
    const gitEntry = gitChurn.get(normalizedPath);

    let churnCount = 0;
    const authors = new Set<string>();

    if (gitEntry) {
      // Real change frequency from git history.
      churnCount = gitEntry.count;
      for (const a of gitEntry.authors) authors.add(a);
    } else {
      // No git data for this file — fall back to agent-touch signal only
      // (no fabricated counts).
      if (file.agentTouched && file.agentTouchedAt) {
        const touchDate = new Date(file.agentTouchedAt);
        if (touchDate >= cutoff) {
          churnCount = 1; // at least one recorded touch
          authors.add(file.agentTouchedBy || 'agent');
        }
      }
    }

    // Risk score combines churn frequency and cognitive load
    const normalizedChurn = Math.min(churnCount / 20, 1); // Normalize to 0-1
    const normalizedLoad = Math.min(file.cognitiveLoad / 0.5, 1); // Normalize to 0-1
    const riskScore = (normalizedChurn * 0.6) + (normalizedLoad * 0.4);

    if (churnCount > 0 || riskScore > 0.1) {
      results.push({
        path: file.relativePath,
        churnCount,
        cognitiveLoad: file.cognitiveLoad,
        riskScore,
        authors: Array.from(authors),
      });
    }
  }

  return results;
}

function generateHtmlChurn(churnData: any[], highRisk: any[], threshold: number): string {
  const rows = churnData.map(item => `
    <tr class="${item.riskScore >= threshold ? 'high-risk' : item.riskScore >= threshold * 0.5 ? 'medium-risk' : 'low-risk'}">
      <td>${item.path}</td>
      <td>${item.churnCount}</td>
      <td>${item.cognitiveLoad.toFixed(3)}</td>
      <td>${(item.riskScore * 100).toFixed(1)}%</td>
      <td>${item.authors.join(', ')}</td>
    </tr>
  `).join('');
  
  return `<!DOCTYPE html>
<html>
<head>
  <title>Code Churn & Risk Analysis</title>
  <style>
    body { font-family: system-ui; max-width: 1400px; margin: 2rem auto; padding: 1rem; }
    .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; margin-bottom: 1rem; }
    .stat { padding: 1rem; background: #f5f5f5; border-radius: 4px; text-align: center; }
    .stat .value { font-size: 2rem; font-weight: bold; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #ddd; padding: 0.5rem; text-align: left; }
    th { background: #f5f5f5; position: sticky; top: 0; }
    .high-risk { background: #ffebee; }
    .medium-risk { background: #fff3e0; }
    .low-risk { background: #e8f5e9; }
  </style>
</head>
<body>
  <h1>Code Churn & Risk Analysis</h1>
  <div class="stats">
    <div class="stat"><div class="value">${churnData.length}</div><div class="label">Files Analyzed</div></div>
    <div class="stat"><div class="value" style="color: #c62828;">${highRisk.length}</div><div class="label">High Risk (≥${(threshold*100).toFixed(0)}%)</div></div>
    <div class="stat"><div class="value">${(Math.max(...churnData.map(c => c.riskScore)) * 100).toFixed(1)}%</div><div class="label">Max Risk</div></div>
    <div class="stat"><div class="value">${(churnData.reduce((s, c) => s + c.churnCount, 0)).toFixed(0)}</div><div class="label">Total Churn Events</div></div>
  </div>
  <table>
    <thead><tr><th>File</th><th>Churn Count</th><th>Cognitive Load</th><th>Risk Score</th><th>Authors</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`;
}