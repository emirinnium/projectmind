import { Command } from 'commander';
import { BaseCommand, asyncHandler, output } from '@/cli/utils/shared.js';

class AgentCommand extends BaseCommand {
  constructor() {
    super('agent', 'Manage and inspect agent sessions and coverage');
  }

  registerCommands(): Command {
    const agentCmd = this.cmd;

    agentCmd
      .command('status')
      .description('Show current agent status and coverage')
      .action(
        asyncHandler(async () => {
          await this.withContext(async (ctx) => {
            const sessions = ctx.kg.getAgentSessions();
            const touchedFiles = ctx.kg.getAgentTouchedFiles();
            const allFiles = ctx.kg.getAllFiles();

            output.section('Agent Status');
            output.kv('Active sessions', sessions.filter((s) => !s.endedAt).length);
            output.kv('Total sessions', sessions.length);
            output.kv('Files touched', touchedFiles.length);
            output.kv('Total files', allFiles.length);
            output.kv(
              'Coverage',
              `${((touchedFiles.length / Math.max(allFiles.length, 1)) * 100).toFixed(1)}%`,
            );

            if (sessions.length > 0) {
              output.section('Recent Sessions');
              for (const s of sessions.slice(0, 10)) {
                const status = s.endedAt ? 'ended' : 'active';
                output.kv(`  ${s.agentName} (${s.id})`, `${status} since ${s.startedAt}`);
              }
            }

            if (touchedFiles.length > 0) {
              output.section('Recently Touched Files');
              for (const f of touchedFiles.slice(0, 10)) {
                output.kv(`  ${f.relativePath}`, `by=${f.agentTouchedBy}, at=${f.agentTouchedAt}`);
              }
            }
          });
        }),
      );

    agentCmd
      .command('start')
      .description('Start an agent session')
      .argument('[name]', 'Agent name', 'ai-agent')
      .action(
        asyncHandler(async (name: string) => {
          await this.withContext(async (ctx) => {
            const sessionId = ctx.kg.startAgentSession(name);
            output.success(`Session started: ${name} (ID: ${sessionId})`);
          });
        }),
      );

    agentCmd
      .command('end')
      .description('End an agent session')
      .argument('<id>', 'Session ID')
      .action(
        asyncHandler(async (id: string) => {
          await this.withContext(async (ctx) => {
            ctx.kg.endAgentSession(Number(id));
            output.success(`Session ${id} ended.`);
          });
        }),
      );

    agentCmd
      .command('touch')
      .description('Mark a file as touched by an agent')
      .argument('<file>', 'File path')
      .option('-a, --agent <name>', 'Agent name', 'ai-agent')
      .action(
        asyncHandler(async (file: string, opts: { agent: string }) => {
          await this.withContext(async (ctx) => {
            ctx.kg.markAgentTouched(file, opts.agent);
            output.success(`Marked ${file} as touched by ${opts.agent}`);
          });
        }),
      );

    agentCmd
      .command('coverage')
      .description('Show detailed agent coverage report')
      .action(
        asyncHandler(async () => {
          await this.withService(['scale'], async (_ctx, services) => {
            const scale = services.scale!;
            const report = scale.getScaleReport();

            output.section('Agent Coverage Report');
            output.kv('Overall coverage', `${(report.agentCoverage * 100).toFixed(1)}%`);

            output.section('Module Coverage');
            for (const mod of report.modules) {
              const bar =
                '█'.repeat(Math.floor(mod.agentCoverage * 10)) +
                '░'.repeat(10 - Math.floor(mod.agentCoverage * 10));
              output.kv(
                `  ${bar} ${mod.path}`,
                `${mod.fileCount} files, ${(mod.agentCoverage * 100).toFixed(1)}% covered`,
              );
            }

            output.section('Uncovered High-Load Files');
            for (const f of report.uncoveredFiles.slice(0, 10)) {
              output.kv(`  ${f.relativePath}`, `load=${f.cognitiveLoad.toFixed(3)}`);
            }
          });
        }),
      );

    return agentCmd;
  }
}

export function createAgentCommand(): Command {
  return new AgentCommand().registerCommands();
}
