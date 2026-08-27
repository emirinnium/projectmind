import { Command } from 'commander';
import { withService, asyncHandler, output } from '@/cli/utils/shared.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_CATALOG, analyzeSkillGaps, estimateAllProficiencies, extractCodebaseSkills, generateSkillDoc, type SkillGap } from '@/core/skills/engine.js';

/**
 * B5 — Agent skill generation from interaction history.
 *
 * Unlike the old hardcoded catalog, proficiency is derived from REAL evidence:
 * agent sessions, per-agent touched files (files.agent_touched_by), session
 * decisions, and the measured coding fingerprint. `--write` emits a
 * personalized `skills/<agent>/SKILL.md` explaining what each skill is for
 * and exactly which commands apply it.
 */
export function createSkillRecommendCommand(): Command {
  const skillCmd = new Command('skill-recommend')
    .description('Recommend skill improvements from agent interaction history (evidence-based)')
    .option('-a, --agent <name>', 'Specific agent to analyze')
    .option('--all', 'Analyze all agents')
    .option('--gap-threshold <n>', 'Minimum gap to report (0-1)', '0.3')
    .option('--top <n>', 'Top N recommendations per agent', '10')
    .option('--format <fmt>', 'Output: text|json|html', 'text')
    .option('--write', 'Generate skills/<agent>/SKILL.md for each analyzed agent')
    .option('-o, --output <file>', 'Write report to file')
    .action(asyncHandler(async (opts: { agent: string; all: boolean; gapThreshold: string; top: string; format: string; write: boolean; output: string }) => {
      await withService(['scale', 'coherence'], async (ctx, services) => {
        const scale = services.scale!;
        const kg = ctx.kg;

        output.section('Agent Skill Gap Analysis (evidence-based)');
        output.kv('Gap threshold', opts.gapThreshold);
        output.kv('Top N', opts.top);

        const report = scale.getScaleReport();
        const codebaseSkills = extractCodebaseSkills(report.modules);
        const catalogCoverage = Object.keys(codebaseSkills).length;
        output.kv('Repo skill evidence', `${catalogCoverage}/${SKILL_CATALOG.length} skills in evidence`);

        let agentsToAnalyze = scale.getAgentProfiles();
        if (opts.agent) {
          agentsToAnalyze = agentsToAnalyze.filter((p) => p.name === opts.agent);
        }

        if (agentsToAnalyze.length === 0) {
          output.warn('No agents found. Run a scan and use the tools to generate agent sessions first.');
          return;
        }

        output.kv('Agents to analyze', agentsToAnalyze.length);

        const sessions = kg.getAgentSessions();
        const allFiles = kg.getAllFiles();
        const touchedByAgent = new Map<string, string[]>();
        for (const f of allFiles) {
          if (f.agentTouchedBy === null) continue;
          const list = touchedByAgent.get(f.agentTouchedBy) ?? [];
          list.push(f.relativePath);
          touchedByAgent.set(f.agentTouchedBy, list);
        }

        const allGaps: { agent: string; gaps: SkillGap[] }[] = [];

        for (const profile of agentsToAnalyze) {
          const touchedPaths = (touchedByAgent.get(profile.name) ?? []).map((p) => p.replace(/\\/g, '/'));
          const agentSessions = sessions.filter((s) => s.agentName === profile.name);
          const decisionsText = agentSessions
            .map((s) => JSON.stringify(s.decisions ?? null))
            .filter((t) => t !== 'null')
            .join(' ');

          const proficiencies = estimateAllProficiencies({
            sessionCount: profile.sessions,
            touchedPaths,
            decisionsText,
            asyncPreference: profile.fingerprint?.asyncPreference ?? -1,
          });
          const gaps = analyzeSkillGaps(proficiencies, codebaseSkills, parseFloat(opts.gapThreshold));
          allGaps.push({ agent: profile.name, gaps });

          output.info(`Agent '${profile.name}': ${profile.sessions} sessions, ${profile.filesTouched} files touched, ${gaps.length} skill gaps.`);
          if (opts.write) {
            const doc = generateSkillDoc({
              agentName: profile.name,
              sessionCount: profile.sessions,
              filesTouchedCount: profile.filesTouched,
              fingerprint: profile.fingerprint,
              touchedPaths,
              gaps,
              generatedAt: new Date().toISOString(),
            });
            writeSkillDoc(profile.name, doc);
          }
        }

        if (opts.format === 'json') {
          const result = { agents: allGaps, codebaseSkills, catalogVersion: 2 };
          const content = JSON.stringify(result, null, 2);
          if (opts.output) {
            writeFileSync(opts.output, content);
            output.success(`Written to ${opts.output}`);
          } else {
            console.log(content);
          }
          return;
        }

        if (opts.format === 'html') {
          const content = generateHtmlSkillReport(allGaps);
          if (opts.output) {
            writeFileSync(opts.output, content);
            output.success(`Written to ${opts.output}`);
          } else {
            console.log(content);
          }
          return;
        }

        // Text format
        for (const { agent, gaps } of allGaps) {
          output.section(`Agent: ${agent} (${gaps.length} gaps)`);

          if (gaps.length === 0) {
            output.success('No significant skill gaps detected');
            continue;
          }

          for (const [i, gap] of gaps.slice(0, parseInt(opts.top, 10)).entries()) {
            const priorityIcon = gap.priority === 'critical' ? '🔴' : gap.priority === 'high' ? '🟠' : gap.priority === 'medium' ? '🟡' : '🟢';
            output.kv(
              `${i + 1}. ${priorityIcon} ${gap.label}`,
              `Gap: ${(gap.gap * 100).toFixed(0)}% (${(gap.currentLevel * 100).toFixed(0)} → ${(gap.targetLevel * 100).toFixed(0)}) | Effort: ${gap.estimatedHours}h`,
            );
            output.kv('  Why it helps', gap.whyItHelps);
            output.kv('  Commands', gap.suggestedCommands.join(', '));
            if (gap.relatedFiles.length > 0) {
              output.kv('  Files', gap.relatedFiles.slice(0, 3).join(', '));
            }
          }

          const criticalCount = gaps.filter((g) => g.priority === 'critical').length;
          const highCount = gaps.filter((g) => g.priority === 'high').length;
          output.kv('Total gaps', gaps.length);
          output.kv('Critical', criticalCount);
          output.kv('High', highCount);
        }

        // Overall recommendations
        output.section('Top Recommendations');
        const topOverall = allGaps
          .flatMap((a) => a.gaps.map((g) => ({ ...g, agent: a.agent })))
          .sort((a, b) => b.gap - a.gap)
          .slice(0, 5);
        for (const [i, gap] of topOverall.entries()) {
          output.kv(`${i + 1}. ${gap.label} (${gap.agent})`, `Gap: ${(gap.gap * 100).toFixed(0)}% — ${gap.whyItHelps}`);
        }

        if (opts.output) {
          writeFileSync(opts.output, JSON.stringify({ agents: allGaps, codebaseSkills }, null, 2));
          output.success(`Written to ${opts.output}`);
        }
        if (opts.write) {
          output.success(`SKILL.md files written under skills/<agent>/ (${agentsToAnalyze.length} agent(s)).`);
        }
      });
    }));

  return skillCmd;
}

function writeSkillDoc(agentName: string, doc: string): void {
  const dir = join(process.cwd(), 'skills', agentName);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'SKILL.md');
  writeFileSync(file, doc);
  output.success(`Generated ${file}`);
}

function generateHtmlSkillReport(allGaps: { agent: string; gaps: SkillGap[] }[]): string {
  const rows = allGaps
    .flatMap(({ agent, gaps }) =>
      gaps.map(
        (g) => `
      <tr class="${g.priority}">
        <td>${agent}</td>
        <td>${g.label}</td>
        <td>${(g.currentLevel * 100).toFixed(0)}%</td>
        <td>${(g.targetLevel * 100).toFixed(0)}%</td>
        <td>${(g.gap * 100).toFixed(0)}%</td>
        <td>${g.priority}</td>
        <td>${g.estimatedHours}h</td>
        <td title="${escapeHtml(g.whyItHelps)}">${g.suggestedCommands.slice(0, 2).join(', ')}</td>
      </tr>
    `,
      ),
    )
    .join('');

  return `<!DOCTYPE html>
<html>
<head>
  <title>Agent Skill Gap Analysis</title>
  <style>
    body { font-family: system-ui; max-width: 1400px; margin: 2rem auto; padding: 1rem; }
    .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; margin: 1rem 0; }
    .stat { padding: 1rem; background: #f5f5f5; border-radius: 4px; text-align: center; }
    .stat .value { font-size: 2rem; font-weight: bold; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #ddd; padding: 0.5rem; text-align: left; }
    th { background: #f5f5f5; position: sticky; top: 0; }
    .critical { background: #ffebee; }
    .high { background: #fff3e0; }
    .medium { background: #fffde7; }
    .low { background: #e8f5e9; }
  </style>
</head>
<body>
  <h1>Agent Skill Gap Analysis (evidence-based)</h1>
  <div class="stats">
    <div class="stat"><div class="value">${allGaps.length}</div><div class="label">Agents Analyzed</div></div>
    <div class="stat"><div class="value">${allGaps.reduce((s, a) => s + a.gaps.length, 0)}</div><div class="label">Total Gaps</div></div>
    <div class="stat"><div class="value">${allGaps.flatMap((a) => a.gaps).filter((g) => g.priority === 'critical').length}</div><div class="label">Critical</div></div>
    <div class="stat"><div class="value">${allGaps.flatMap((a) => a.gaps).filter((g) => g.priority === 'high').length}</div><div class="label">High</div></div>
  </div>
  <table>
    <thead>
      <tr><th>Agent</th><th>Skill</th><th>Current</th><th>Target</th><th>Gap</th><th>Priority</th><th>Effort (h)</th><th>Commands</th></tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}