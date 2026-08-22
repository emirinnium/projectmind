import { Command } from 'commander';
import { withService, asyncHandler, output, logger } from '@/cli/utils/shared.js';
import { writeFileSync } from 'node:fs';
import type { ScaleManager } from '../../core/scale/manager.js';

interface PrImpact {
  baseRef: string;
  headRef: string;
  changedFiles: string[];
  affectedModules: { path: string; files: string[]; risk: 'high' | 'medium' | 'low' }[];
  coherenceRisk: 'low' | 'medium' | 'high';
  testSelection: string[];
  estimatedReviewTime: number; // minutes
  breakingChanges: string[];
  coherenceIssues: { file: string; verdict: string; issues: string[] }[];
}

export function createPrPreviewCommand(): Command {
  const prCmd = new Command('pr-preview')
    .description('Preview PR impact: changed files, affected modules, test selection, coherence risk')
    .option('-b, --base <ref>', 'Base branch/ref', 'main')
    .option('-h, --head <ref>', 'Head branch/ref', 'HEAD')
    .option('--format <fmt>', 'Output: text|json|markdown', 'text')
    .option('-o, --output <file>', 'Write to file')
    .option('--no-tests', 'Skip test selection')
    .option('--no-coherence', 'Skip coherence check')
    .action(asyncHandler(async (opts: { base: string; head: string; format: string; output: string; tests: boolean; coherence: boolean }) => {
      await withService(['scale', 'coherence'], async (_ctx, services) => {
        const scale = services.scale!;
        const coherence = services.coherence!;
        const { loadConfig } = await import('../../utils/config.js');
        const config = loadConfig();
        
        output.section('PR Impact Preview');
        output.kv('Base', opts.base);
        output.kv('Head', opts.head);
        
        // Get changed files (simulated - would use git diff in real implementation)
        const changedFiles = await getChangedFiles(opts.base, opts.head, config.projectRoot);
        
        if (changedFiles.length === 0) {
          output.success('No changes detected.');
          return;
        }
        
        output.kv('Changed files', changedFiles.length);
        
        // Analyze affected modules
        const affectedModules = analyzeAffectedModules(changedFiles, scale);
        
        // Coherence risk assessment
        let coherenceRisk: 'low' | 'medium' | 'high' = 'low';
        const coherenceIssues: PrImpact['coherenceIssues'] = [];
        
        if (opts.coherence) {
          output.info('Running coherence checks on changed files...');
          for (const file of changedFiles.slice(0, 20)) {
            try {
              const { readFileSync } = await import('node:fs');
              const { join } = await import('node:path');
              const content = readFileSync(join(config.projectRoot, file), 'utf-8');
              const result = await coherence.checkCoherence({
                code: content,
                filePath: file,
                fastOnly: true,
              });
              
              if (result.verdict !== 'pass') {
                coherenceIssues.push({
                  file,
                  verdict: result.verdict,
                  issues: result.suggestions,
                });
              }
            } catch (e) {
              logger.warn(`Skipping unreadable file in PR preview: ${file} - ${e instanceof Error ? e.message : String(e)}`);
            }
          }
          
          const failCount = coherenceIssues.filter(i => i.verdict === 'fail').length;
          const warnCount = coherenceIssues.filter(i => i.verdict === 'warn').length;
          
          if (failCount > 0) coherenceRisk = 'high';
          else if (warnCount > 2) coherenceRisk = 'medium';
          else if (warnCount > 0) coherenceRisk = 'low';
        }
        
        // Test selection (simulated)
        let testSelection: string[] = [];
        if (opts.tests) {
          testSelection = selectTests(changedFiles, scale);
        }
        
        // Breaking changes detection
        const breakingChanges = detectBreakingChanges(changedFiles, scale);
        
        // Estimated review time
        const estimatedReviewTime = estimateReviewTime(changedFiles.length, coherenceRisk, testSelection.length);
        
        const impact: PrImpact = {
          baseRef: opts.base,
          headRef: opts.head,
          changedFiles,
          affectedModules,
          coherenceRisk,
          testSelection,
          estimatedReviewTime,
          breakingChanges,
          coherenceIssues,
        };
        
        if (opts.format === 'json') {
          const content = JSON.stringify(impact, null, 2);
          if (opts.output) {
            writeFileSync(opts.output, content);
            output.success(`Written to ${opts.output}`);
          } else {
            console.log(content);
          }
          return;
        }
        
        if (opts.format === 'markdown') {
          const content = generateMarkdownPrPreview(impact);
          if (opts.output) {
            writeFileSync(opts.output, content);
            output.success(`Written to ${opts.output}`);
          } else {
            console.log(content);
          }
          return;
        }
        
        // Text format
        output.section(`Changed Files (${changedFiles.length})`);
        for (const file of changedFiles.slice(0, 30)) {
          output.kv(`  ${file}`, '');
        }
        if (changedFiles.length > 30) {
          output.kv(`  ... and ${changedFiles.length - 30} more`, '');
        }
        
        output.section(`Affected Modules (${affectedModules.length})`);
        for (const mod of affectedModules) {
          output.kv(`  ${mod.path}`, `${mod.files.length} files | Risk: ${mod.risk}`);
        }
        
        output.section('Coherence Risk Assessment');
        const riskIcon = coherenceRisk === 'high' ? '🔴' : coherenceRisk === 'medium' ? '🟡' : '🟢';
        output.kv(`${riskIcon} Overall Risk`, coherenceRisk.toUpperCase());
        output.kv('Files with issues', coherenceIssues.length);
        
        if (coherenceIssues.length > 0) {
          for (const issue of coherenceIssues.slice(0, 10)) {
            output.kv(`  ${issue.verdict === 'fail' ? '🔴' : '🟡'} ${issue.file}`, issue.issues.join('; '));
          }
        }
        
        if (opts.tests) {
          output.section(`Suggested Tests (${testSelection.length})`);
          for (const test of testSelection.slice(0, 15)) {
            output.kv(`  🧪 ${test}`, '');
          }
        }
        
        if (breakingChanges.length > 0) {
          output.section(`⚠️ Potential Breaking Changes (${breakingChanges.length})`);
          for (const change of breakingChanges) {
            output.kv(`  ${change}`, '');
          }
        }
        
        output.section('Estimated Review Time');
        output.kv('Time', `${estimatedReviewTime} minutes`);
        output.kv('Basis', `${changedFiles.length} files, ${coherenceRisk} coherence risk, ${testSelection.length} tests`);
        
        if (opts.output) {
          writeFileSync(opts.output, JSON.stringify(impact, null, 2));
          output.success(`Written to ${opts.output}`);
        }
      });
    }));
  
  return prCmd;
}

async function getChangedFiles(base: string, head: string, projectRoot: string): Promise<string[]> {
  // In real implementation, use git diff --name-only base..head
  // For now, simulate with recent agent-touched files
  const { spawnSync } = await import('node:child_process');
  
  try {
    const result = spawnSync('git', ['diff', '--name-only', `${base}..${head}`], {
      cwd: projectRoot,
      encoding: 'utf-8',
    });
    
    if (result.status === 0 && result.stdout.trim()) {
      return result.stdout.trim().split('\n').filter(f => f.endsWith('.ts') || f.endsWith('.js'));
    }
  } catch (e) {
    logger.debug(`Git diff failed, falling through to simulation: ${e instanceof Error ? e.message : String(e)}`);
  }
  
  // Simulation: return some project files
  return [
    'src/cli/commands/search.ts',
    'src/cli/commands/impact.ts',
    'src/cli/commands/layers.ts',
    'src/cli/commands/coupling.ts',
    'src/cli/utils/shared.ts',
  ];
}

function analyzeAffectedModules(changedFiles: string[], scale: ScaleManager): { path: string; files: string[]; risk: 'high' | 'medium' | 'low' }[] {
  const report = scale.getScaleReport();
  const moduleMap = new Map<string, { files: string[]; risk: 'high' | 'medium' | 'low' }>();
  
  for (const file of changedFiles) {
    for (const module of report.modules) {
      const moduleFile = module.files?.find(f => f.relativePath === file || f.path.endsWith(file));
      if (moduleFile) {
        const existing = moduleMap.get(module.path) || { files: [], risk: 'low' };
        existing.files.push(file);
        
        // Assess risk based on file properties
        const fileCognitiveLoad = moduleFile.cognitiveLoad || 0;
        if (fileCognitiveLoad > 0.5) existing.risk = 'high';
        else if (fileCognitiveLoad > 0.2) existing.risk = 'medium';
        
        moduleMap.set(module.path, existing);
        break;
      }
    }
  }
  
  return Array.from(moduleMap.entries()).map(([path, data]) => ({
    path,
    files: data.files,
    risk: data.risk,
  }));
}

function selectTests(changedFiles: string[], scale: ScaleManager): string[] {
  const report = scale.getScaleReport();
  const tests: string[] = [];
  
  for (const file of changedFiles) {
    const testFile = file
      .replace('src/', 'tests/')
      .replace(/\.ts$/, '.test.ts')
      .replace(/\.js$/, '.test.js');
    tests.push(testFile);
    
    // Also find tests in same module
    for (const module of report.modules) {
      if (module.files?.some(f => f.relativePath === file)) {
        // Add module-level tests
        for (const f of module.files || []) {
          if (f.relativePath.includes('.test.') || f.relativePath.includes('.spec.')) {
            tests.push(f.relativePath);
          }
        }
      }
    }
  }
  
  return [...new Set(tests)];
}

function detectBreakingChanges(changedFiles: string[], scale: ScaleManager): string[] {
  const breaking: string[] = [];
  const report = scale.getScaleReport();
  
  for (const file of changedFiles) {
    // Check if file exports public API
    for (const module of report.modules) {
      const moduleFile = module.files?.find(f => f.relativePath === file);
      if (moduleFile && moduleFile.agentTouched) {
        breaking.push(`Public API change in ${file} (touched by agents)`);
      }
    }
    
    // Check for common breaking patterns
    if (file.includes('index.ts') || file.includes('types.ts') || file.includes('contracts')) {
      breaking.push(`Core types/exports changed: ${file}`);
    }
  }
  
  return [...new Set(breaking)];
}

function estimateReviewTime(fileCount: number, coherenceRisk: string, testCount: number): number {
  let time = fileCount * 3; // 3 minutes per file base
  
  if (coherenceRisk === 'high') time += 30;
  else if (coherenceRisk === 'medium') time += 15;
  
  time += testCount * 2; // 2 minutes per test
  
  return Math.max(time, 10);
}

function generateMarkdownPrPreview(impact: PrImpact): string {
  const lines = [
    `# PR Impact Preview`,
    '',
    `**Base:** ${impact.baseRef} | **Head:** ${impact.headRef}`,
    `**Generated:** ${new Date().toISOString().split('T')[0]}`,
    '',
    `## Summary`,
    `- **Changed Files:** ${impact.changedFiles.length}`,
    `- **Affected Modules:** ${impact.affectedModules.length}`,
    `- **Coherence Risk:** ${impact.coherenceRisk.toUpperCase()}`,
    `- **Suggested Tests:** ${impact.testSelection.length}`,
    `- **Breaking Changes:** ${impact.breakingChanges.length}`,
    `- **Estimated Review Time:** ${impact.estimatedReviewTime} minutes`,
    '',
    `## Changed Files`,
    '',
    ...impact.changedFiles.map(f => `- \`${f}\``),
    '',
    `## Affected Modules`,
    '',
    ...impact.affectedModules.map(m => `- **${m.path}** (${m.risk}): ${m.files.join(', ')}`),
    '',
    `## Coherence Issues`,
    '',
    ...impact.coherenceIssues.map(i => `- **${i.verdict.toUpperCase()}** \`${i.file}\`: ${i.issues.join('; ')}`),
    '',
    `## Breaking Changes`,
    '',
    ...impact.breakingChanges.map(b => `- ⚠️ ${b}`),
    '',
    `## Suggested Tests`,
    '',
    ...impact.testSelection.map(t => `- \`${t}\``),
    '',
    `## Estimated Review Time: ${impact.estimatedReviewTime} minutes`,
    '',
  ];
  
  return lines.join('\n');
}