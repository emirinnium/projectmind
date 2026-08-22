import { Command } from 'commander';
import { withService, asyncHandler, output } from '@/cli/utils/shared.js';

export function createImpactCommand(): Command {
  return new Command('impact')
    .description('Analyze change impact using dependency data')
    .argument('<file>', 'File path to analyze')
    .option('-d, --depth <n>', 'Dependency depth (informational)', '2')
    .action(asyncHandler(async (filePath: string) => {
      await withService(['scale'], async (_ctx, services) => {
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