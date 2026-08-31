import { Command } from 'commander';
import { basename, dirname } from 'node:path';
import { withService, asyncHandler, output } from '@/cli/utils/shared.js';
import { ImpactPredictor } from '../../core/predictive/impact-predictor.js';
import { DEFAULT_PREDICTOR_CONFIG } from '../../core/predictive/config.js';
import type { CodeChange } from '../../core/predictive/types.js';

export function createImpactCommand(): Command {
  return new Command('impact')
    .description('Analyze change impact using dependency data')
    .argument('<file>', 'File path to analyze')
    .option('-d, --depth <n>', 'Dependency depth (informational)', '2')
    .option('-t, --tests', 'List tests/specs inside the reverse-dependency closure (test impact)')
    .action(asyncHandler(async (filePath: string, opts: { tests?: boolean }) => {
      await withService(['scale'], async (ctx, services) => {
        const scale = services.scale!;
        
        output.section(`Change Impact: ${filePath}`);
        
        const report = scale.getScaleReport();
        const allFiles = report.modules.flatMap(m => m.files || []);
        const targetFile = allFiles.find(f => f.path.includes(filePath) || filePath.includes(f.path));
        
        if (!targetFile) {
          output.warn(`File not found in knowledge graph: ${filePath}`);
          output.info('Run "projectmind scan" first to populate the knowledge graph.');
          return;
        }
        
        output.kv('File', targetFile.path);
        output.kv('Cognitive load', targetFile.cognitiveLoad.toFixed(3));
        output.kv('Agent touched', targetFile.agentTouched ? 'yes' : 'no');

        // F39: predictive analysis via ImpactPredictor (working tree vs git
        // HEAD signature diff + KG call-graph + historical test failures).
        // Any failure degrades gracefully to the dependency analysis below.
        try {
          const predictor = new ImpactPredictor(DEFAULT_PREDICTOR_CONFIG, ctx.db);
          // previous content defaults to `git show HEAD:<file>` inside the
          // predictor — the cheap "recent git diff" path; without git history
          // it degrades to a signature-based what-if on the current content.
          const change: CodeChange = {
            filePath: targetFile.path,
            moduleName: basename(dirname(targetFile.path)) || targetFile.path,
            changeType: 'modify',
            crossModule: false,
          };
          const prediction = predictor.predictImpact(change);
          const historical = predictor.correlateHistoricalFailures(targetFile.path);
          const breaks = predictor.predictTestBreaks(change);

          output.section('Predicted Impact (ImpactPredictor)');
          output.kv('Predicted impact', `${(prediction.predictedImpact * 100).toFixed(1)}%`);
          output.kv('Confidence', `${(prediction.totalConfidence * 100).toFixed(1)}%`);
          output.kv('Affected modules', prediction.affectedModules.join(', ') || 'none');
          output.kv('Historical failure rate', `${(historical.avgFailureRate * 100).toFixed(1)}%`);
          if (historical.commonBrokenTests.length > 0) {
            output.kv('Common broken tests', historical.commonBrokenTests.join(', '));
          }
          if (breaks.length > 0) {
            output.section(`Predicted Test Breaks (${breaks.length})`);
            for (const b of breaks.slice(0, 10)) {
              output.warn(`  ${b.functionName} (${Math.round(b.confidence * 100)}%): ${b.reason.substring(0, 120)}`);
            }
            if (breaks.length > 10) output.info(`...and ${breaks.length - 10} more`);
          } else {
            output.info('No signature/type-level breakage predicted for the current diff.');
          }
        } catch (error) {
          output.info(
            `ImpactPredictor unavailable (${error instanceof Error ? error.message : String(error)}) — using dependency analysis below.`
          );
        }

        // Test impact: BFS over the reverse-dependency closure via the KG.
        if (opts.tests) {
          const kg = (ctx as { kg?: { getDependents(id: number): Array<{ id: number; relativePath: string }> } }).kg;
          if (kg && typeof targetFile.id === 'number') {
            const isTestPath = (p: string): boolean =>
              /(^|\/)(tests?|__tests__)\//.test(p) || /\.(test|spec)\.[a-z]+$/i.test(p);
            const visited = new Set<number>([targetFile.id]);
            const queue: Array<{ id: number; rel: string; depth: number }> = [{ id: targetFile.id, rel: targetFile.relativePath, depth: 0 }];
            const impactedTests: Array<{ rel: string; depth: number }> = [];
            while (queue.length > 0) {
              const cur = queue.shift()!;
              for (const dep of kg.getDependents(cur.id)) {
                if (visited.has(dep.id)) continue;
                visited.add(dep.id);
                if (isTestPath(dep.relativePath)) impactedTests.push({ rel: dep.relativePath, depth: cur.depth + 1 });
                queue.push({ id: dep.id, rel: dep.relativePath, depth: cur.depth + 1 });
              }
            }
            impactedTests.sort((a, b) => a.depth - b.depth);
            output.section(`Impacted Tests (${impactedTests.length})`);
            if (impactedTests.length === 0) {
              output.info('No tests transitively import this file — changes are not covered by the test graph.');
            } else {
              for (const t of impactedTests.slice(0, 25)) {
                output.kv(`  🧪 ${t.rel}`, `depth: ${t.depth}`);
              }
              if (impactedTests.length > 25) output.info(`...and ${impactedTests.length - 25} more`);
              output.kv('Run these before committing', `${impactedTests.length} test file(s)`);
            }
          } else {
            output.info('--tests requires a scanned knowledge graph (run "projectmind scan" first).');
          }
        }
        
        // Find module containing this file
        const targetModule = report.modules.find(m => m.files?.some(f => f.path === targetFile.path));
        if (targetModule) {
          output.kv('Module', targetModule.path);
          
          // Show other files in same module
          const moduleFiles = targetModule.files?.filter(f => f.path !== targetFile.path) || [];
          output.section(`Same Module Files (${moduleFiles.length})`);
          for (const f of moduleFiles.slice(0, 20)) {
            output.kv(`  ${f.path}`, `load: ${f.cognitiveLoad.toFixed(3)}`);
          }
        }
        
        // Show high-load files that might be affected
        const highLoad = allFiles.filter(f => f.cognitiveLoad > 0.7 && f.path !== targetFile.path);
        if (highLoad.length > 0) {
          output.section(`High-Load Files (potential ripple)`);
          for (const f of highLoad.slice(0, 10)) {
            output.kv(`  ${f.path}`, `load: ${f.cognitiveLoad.toFixed(3)}`);
          }
        }
        
        output.info('Note: Full transitive impact analysis requires additional core services.');
      });
    }));
}