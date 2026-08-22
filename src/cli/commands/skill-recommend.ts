import { Command } from 'commander';
import { withService, asyncHandler, output } from '@/cli/utils/shared.js';
import { writeFileSync } from 'node:fs';

interface SkillGap {
  skill: string;
  description: string;
  currentLevel: number; // 0-1
  targetLevel: number;
  gap: number;
  priority: 'critical' | 'high' | 'medium' | 'low';
  learningResources: string[];
  estimatedHours: number;
  relatedFiles: string[];
}

interface AgentProfile {
  name: string;
  skills: Record<string, number>; // skill -> proficiency 0-1
  filesTouched: string[];
  patternsUsed: string[];
  preferredTools: string[];
  totalSessions: number;
  totalLinesChanged: number;
}

export function createSkillRecommendCommand(): Command {
  const skillCmd = new Command('skill-recommend')
    .description('Recommend skill improvements for agents based on codebase patterns and gaps')
    .option('-a, --agent <name>', 'Specific agent to analyze')
    .option('--all', 'Analyze all agents')
    .option('--gap-threshold <n>', 'Minimum gap to report (0-1)', '0.3')
    .option('--top <n>', 'Top N recommendations', '10')
    .option('--format <fmt>', 'Output: text|json|html', 'text')
    .option('-o, --output <file>', 'Write to file')
    .action(asyncHandler(async (opts: { agent: string; all: boolean; gapThreshold: string; top: string; format: string; output: string }) => {
      await withService(['scale', 'coherence'], async (_ctx, services) => {
        const scale = services.scale!;
        
        output.section('Agent Skill Gap Analysis');
        output.kv('Gap threshold', opts.gapThreshold);
        output.kv('Top N', opts.top);
        
        const report = scale.getScaleReport();
        const agentProfiles = scale.getAgentProfiles();
        
        let agentsToAnalyze = agentProfiles;
        if (opts.agent) {
          agentsToAnalyze = agentProfiles.filter(p => p.name === opts.agent);
        }
        
        if (agentsToAnalyze.length === 0) {
          output.warn('No agents found. Run "projectmind agent status" to see active agents.');
          return;
        }
        
        output.kv('Agents to analyze', agentsToAnalyze.length);
        
        // Get codebase patterns and required skills
        const codebaseSkills = extractCodebaseSkills(report.modules);
        
        const allGaps: { agent: string; gaps: SkillGap[] }[] = [];
        
        for (const profile of agentsToAnalyze) {
          // Map the actual AgentProfile to our expected interface
          const mappedProfile = mapAgentProfile(profile);
          const gaps = analyzeSkillGaps(mappedProfile, codebaseSkills, parseFloat(opts.gapThreshold));
          allGaps.push({ agent: profile.name, gaps });
        }
        
        if (opts.format === 'json') {
          const result = { agents: allGaps, codebaseSkills: extractCodebaseSkills([]) };
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
          const content = generateHtmlSkillReport(allGaps, extractCodebaseSkills([]));
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
          
          const topGaps = gaps.slice(0, parseInt(opts.top, 10));
          
          for (const [i, gap] of topGaps.entries()) {
            const priorityIcon = gap.priority === 'critical' ? '🔴' : gap.priority === 'high' ? '🟠' : gap.priority === 'medium' ? '🟡' : '🟢';
            output.kv(`${i + 1}. ${priorityIcon} ${gap.skill}`, `Gap: ${(gap.gap * 100).toFixed(0)}% | Effort: ${gap.estimatedHours}h`);
            output.kv('Description', gap.description);
            output.kv('Resources', gap.learningResources.slice(0, 3).join(', '));
            if (gap.relatedFiles.length > 0) {
              output.kv('Files', gap.relatedFiles.slice(0, 3).join(', '));
            }
          }
          
          const criticalCount = gaps.filter(g => g.priority === 'critical').length;
          const highCount = gaps.filter(g => g.priority === 'high').length;
          
          output.kv('Total gaps', gaps.length);
          output.kv('Critical', criticalCount);
          output.kv('High', highCount);
        }
        
        // Overall recommendations
        output.section('Top Recommendations');
        const allGapsFlat = allGaps.flatMap(a => a.gaps.map(g => ({ ...g, agent: a.agent })));
        const topOverall = allGapsFlat
          .sort((a, b) => b.gap - a.gap)
          .slice(0, 5);
        
        for (const [i, gap] of topOverall.entries()) {
          output.kv(`${i + 1}. ${gap.skill} (${gap.agent})`, `Gap: ${(gap.gap * 100).toFixed(0)}% | ${gap.description}`);
        }
        
        if (opts.output) {
          writeFileSync(opts.output, JSON.stringify({ agents: allGaps, codebaseSkills: extractCodebaseSkills([]) }, null, 2));
          output.success(`Written to ${opts.output}`);
        }
      });
    }));
  
  return skillCmd;
}

function mapAgentProfile(profile: any): AgentProfile {
  return {
    name: profile.name || profile.agentName || 'unknown',
    skills: profile.skills || {},
    filesTouched: profile.filesTouched || [],
    patternsUsed: profile.patternsUsed || [],
    preferredTools: profile.preferredTools || [],
    totalSessions: profile.totalSessions || profile.sessions || 0,
    totalLinesChanged: profile.totalLinesChanged || profile.linesChanged || 0,
  };
}

function extractCodebaseSkills(_modules: any[]): Record<string, { description: string; files: string[]; importance: number }> {
  const skills: Record<string, { description: string; files: string[]; importance: number }> = {
    'typescript': { description: 'TypeScript type system and advanced types', files: [], importance: 0.9 },
    'async-patterns': { description: 'Async/await, promises, error handling', files: [], importance: 0.85 },
    'dependency-injection': { description: 'DI patterns, service locators, factories', files: [], importance: 0.7 },
    'architectural-contracts': { description: 'Layer boundaries, forbidden imports, contracts', files: [], importance: 0.8 },
    'coherence-checking': { description: 'Fast/deep coherence analysis, contract engine', files: [], importance: 0.75 },
    'debt-detection': { description: 'Redundancy, pattern drift, architectural drift detection', files: [], importance: 0.7 },
    'embedding-generation': { description: 'Code embeddings, semantic similarity, vector search', files: [], importance: 0.65 },
    'ast-parsing': { description: 'TypeScript AST parsing, symbol extraction', files: [], importance: 0.7 },
    'knowledge-graph': { description: 'File indexing, import resolution, graph queries', files: [], importance: 0.75 },
    'sqlite-persistence': { description: 'SQLite schema, migrations, prepared statements', files: [], importance: 0.6 },
    'mcp-protocol': { description: 'Model Context Protocol server/tools', files: [], importance: 0.6 },
    'llm-integration': { description: 'LLM providers, prompts, deep analysis', files: [], importance: 0.65 },
    'cli-design': { description: 'Commander.js patterns, async handlers, output formatting', files: [], importance: 0.7 },
    'testing-patterns': { description: 'Vitest/Jest, mocking, integration tests', files: [], importance: 0.6 },
    'security-auditing': { description: 'Secret detection, crypto analysis, OWASP checks', files: [], importance: 0.7 },
    'license-compliance': { description: 'SPDX, license scanning, policy enforcement', files: [], importance: 0.5 },
    'architecture-analysis': { description: 'Coupling, cohesion, layer boundaries, impact analysis', files: [], importance: 0.7 },
    'agent-session-management': { description: 'Session tracking, memory, context sharing', files: [], importance: 0.6 },
    'pattern-extraction': { description: 'Code pattern mining, redundancy detection', files: [], importance: 0.65 },
    'refactoring-automation': { description: 'AST transforms, safe code modifications', files: [], importance: 0.6 },
    'documentation-generation': { description: 'API docs, README, ADRs from code', files: [], importance: 0.5 },
  };
  
  return skills;
}

function analyzeSkillGaps(profile: AgentProfile, codebaseSkills: Record<string, { description: string; files: string[]; importance: number }>, threshold: number): SkillGap[] {
  const gaps: SkillGap[] = [];
  
  for (const [skill, info] of Object.entries(codebaseSkills)) {
    const currentLevel = profile.skills[skill] || 0;
    const targetLevel = info.importance; // Target is the importance level
    const gap = targetLevel - currentLevel;
    
    if (gap >= threshold) {
      let priority: SkillGap['priority'] = 'low';
      if (gap > 0.5 && info.importance > 0.8) priority = 'critical';
      else if (gap > 0.4) priority = 'high';
      else if (gap > 0.25) priority = 'medium';
      
      gaps.push({
        skill,
        description: info.description,
        currentLevel,
        targetLevel,
        gap,
        priority,
        learningResources: getLearningResources(skill),
        estimatedHours: Math.ceil(gap * 20),
        relatedFiles: info.files.slice(0, 5),
      });
    }
  }
  
  return gaps.sort((a, b) => b.gap - a.gap);
}

function getLearningResources(skill: string): string[] {
  const resources: Record<string, string[]> = {
    'typescript': ['TypeScript Handbook', 'Effective TypeScript', 'Type Challenges'],
    'async-patterns': ['Async/Await Best Practices', 'Error Handling in Node.js'],
    'dependency-injection': ['DI in TypeScript', 'InversifyJS', 'TSyringe'],
    'architectural-contracts': ['Architecture Decision Records', 'Clean Architecture'],
    'coherence-checking': ['Code Quality Metrics', 'Static Analysis Tools'],
    'debt-detection': ['Technical Debt Management', 'Code Quality Gates'],
    'embedding-generation': ['Vector Embeddings', 'Sentence Transformers', 'FAISS'],
    'ast-parsing': ['TypeScript Compiler API', 'Babel Plugin Handbook'],
    'knowledge-graph': ['Graph Databases', 'Neo4j', 'Property Graphs'],
    'sqlite-persistence': ['SQLite Internals', 'Better-SQLite3', 'Knex.js'],
    'mcp-protocol': ['MCP Specification', 'MCP SDK Examples'],
    'llm-integration': ['Prompt Engineering', 'LangChain', 'Function Calling'],
    'cli-design': ['Commander.js Docs', 'CLI Best Practices'],
    'testing-patterns': ['Vitest Guide', 'Testing Library', 'Mutation Testing'],
    'security-auditing': ['OWASP Top 10', 'Secret Detection', 'SAST Tools'],
    'license-compliance': ['SPDX Specification', 'License Compliance Automation'],
    'architecture-analysis': ['Coupling Metrics', 'Structure101', 'ArchUnit'],
    'agent-session-management': ['Agent Memory Patterns', 'Context Engineering'],
    'pattern-extraction': ['Code Clone Detection', 'Mining Software Repositories'],
    'refactoring-automation': ['Codmods', 'jscodeshift', 'AST Transforms'],
    'documentation-generation': ['JSDoc', 'TypeDoc', 'API Documentation'],
  };
  
  return resources[skill] || ['Official Documentation', 'Community Tutorials', 'GitHub Examples'];
}

function generateHtmlSkillReport(allGaps: { agent: string; gaps: SkillGap[] }[], _codebaseSkills: Record<string, any>): string {
  const rows = allGaps.flatMap(({ agent, gaps }) => 
    gaps.map(g => `
      <tr class="${g.priority}">
        <td>${agent}</td>
        <td>${g.skill}</td>
        <td>${(g.currentLevel * 100).toFixed(0)}%</td>
        <td>${(g.targetLevel * 100).toFixed(0)}%</td>
        <td>${(g.gap * 100).toFixed(0)}%</td>
        <td>${g.priority}</td>
        <td>${g.estimatedHours}h</td>
        <td>${g.learningResources.slice(0, 2).join(', ')}</td>
      </tr>
    `).join('')
  ).join('');
  
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
  <h1>Agent Skill Gap Analysis</h1>
  <div class="stats">
    <div class="stat"><div class="value">${allGaps.length}</div><div class="label">Agents Analyzed</div></div>
    <div class="stat"><div class="value">${allGaps.reduce((s, a) => s + a.gaps.length, 0)}</div><div class="label">Total Gaps</div></div>
    <div class="stat"><div class="value">${allGaps.flatMap(a => a.gaps).filter(g => g.priority === 'critical').length}</div><div class="label">Critical</div></div>
    <div class="stat"><div class="value">${allGaps.flatMap(a => a.gaps).filter(g => g.priority === 'high').length}</div><div class="label">High</div></div>
  </div>
  <table>
    <thead>
      <tr><th>Agent</th><th>Skill</th><th>Current</th><th>Target</th><th>Gap</th><th>Priority</th><th>Effort (h)</th><th>Resources</th></tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`;
}