import { Command } from 'commander';
import { withService, asyncHandler, output } from '@/cli/utils/shared.js';

export function createOwnershipCommand(): Command {
  return new Command('ownership')
    .description('Show agent file ownership from session data')
    .option('--since <days>', 'Days to look back', '30')
    .action(asyncHandler(async (opts: { since: string }) => {
      await withService(['scale'], async (_ctx, services) => {
        const cutoff = new Date(Date.now() - Number(opts.since) * 24 * 60 * 60 * 1000).getTime();
        const scale = services.scale!;
        
        output.section('Agent Ownership');
        
        const report = scale.getScaleReport();
        const agentProfiles = scale.getAgentProfiles();
        
        output.section('Agent Profiles');
        for (const profile of agentProfiles) {
          output.kv(`  ${profile.name}`, `${profile.filesTouched} files | ${profile.sessions} sessions | ${profile.fingerprint?.namingConvention || 'unknown'}`);
        }
        
        output.section('File Ownership (by agent coverage)');
        const allFiles = report.modules.flatMap(m => m.files || []);
        const touchedFiles = allFiles.filter(f => f.agentTouched && (!f.agentTouchedAt || new Date(f.agentTouchedAt).getTime() >= cutoff));
        
        output.kv('Total files', allFiles.length);
        output.kv('Agent-touched files', touchedFiles.length);
        output.kv('Coverage', `${(touchedFiles.length / Math.max(allFiles.length, 1) * 100).toFixed(1)}%`);
        
        const recent = touchedFiles
          .sort((a, b) => (b.agentTouchedAt || '').localeCompare(a.agentTouchedAt || ''))
          .slice(0, 20);
        
        for (const f of recent) {
          output.kv(`  ${f.relativePath}`, `by ${f.agentTouchedBy} at ${f.agentTouchedAt}`);
        }
      });
    }));
}