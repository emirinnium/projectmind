import { Command } from 'commander';
import { withService, asyncHandler, output } from '@/cli/utils/shared.js';
import { writeFileSync } from 'node:fs';
import {
  generateOnboardingPath,
  generateMarkdownOnboarding,
  runInteractiveOnboarding,
} from './onboard-utils.js';

export function createOnboardCommand(): Command {
  const onboardCmd = new Command('onboard')
    .description('Generate personalized onboarding path for new team members')
    .option('-r, --role <role>', 'Role: backend|frontend|fullstack|devops|ml', 'fullstack')
    .option('-d, --depth <n>', 'Depth of exploration (1-5)', '3')
    .option('--format <fmt>', 'Output: text|json|markdown|interactive', 'text')
    .option('-o, --output <file>', 'Write to file')
    .option('--interactive', 'Interactive mode with prompts')
    .action(asyncHandler(async (opts: { role: string; depth: string; format: string; output: string; interactive: boolean }) => {
      await withService(['scale', 'coherence'], async (_ctx, services) => {
        const scale = services.scale!;
        services.coherence!;
        
        output.section(`Onboarding Path Generator - ${opts.role.toUpperCase()}`);
        output.kv('Depth', opts.depth);
        output.kv('Format', opts.format);
        
        const report = scale.getScaleReport();
        const allFiles = report.modules.flatMap(m => m.files || []);
        
        const path = generateOnboardingPath(opts.role, parseInt(opts.depth, 10), report, allFiles);
        
        if (opts.format === 'json') {
          const content = JSON.stringify(path, null, 2);
          if (opts.output) {
            writeFileSync(opts.output, content);
            output.success(`Written to ${opts.output}`);
          } else {
            output.info(content);
          }
          return;
        }
        
        if (opts.format === 'markdown') {
          const content = generateMarkdownOnboarding(path);
          if (opts.output) {
            writeFileSync(opts.output, content);
            output.success(`Written to ${opts.output}`);
          } else {
            output.info(content);
          }
          return;
        }
        
        if (opts.format === 'interactive') {
          await runInteractiveOnboarding(path);
          return;
        }
        
        output.section(`Onboarding Path: ${path.role} (${path.totalSteps} steps, ~${path.totalTime})`);
        
        for (const step of path.steps) {
          const typeIcon = step.type === 'read' ? '📖' : step.type === 'explore' ? '🔍' : step.type === 'run' ? '▶️' : '💪';
          output.section(`Step ${step.order}: ${step.title} ${typeIcon}`);
          output.kv('  Description', step.description);
          output.kv('  Time', step.estimatedTime);
          output.kv('  Type', step.type);
          if (step.prerequisites.length > 0) {
            output.kv('  Prerequisites', step.prerequisites.join(', '));
          }
          if (step.files.length > 0) {
            output.kv('  Key Files', step.files.slice(0, 5).join(', ') + (step.files.length > 5 ? ` +${step.files.length - 5} more` : ''));
          }
        }
        
        output.section('Summary');
        output.kv('Total Steps', path.totalSteps);
        output.kv('Estimated Time', path.totalTime);
        output.kv('Role', path.role);
        
        if (opts.output) {
          writeFileSync(opts.output, JSON.stringify(path, null, 2));
          output.success(`Written to ${opts.output}`);
        }
      });
    }));
  
  return onboardCmd;
}
