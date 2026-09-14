import { Command } from 'commander';
import { BaseCommand, asyncHandler, output, loadConfig } from '@/cli/utils/shared.js';
import { confineToProject } from '@/mcp/tools/_shared.js';

class AgentCommand extends BaseCommand {
  constructor() {
    super('agent', 'Manage and inspect agent sessions and coverage');
  }

  registerCommands(): Command {
    const agentCmd = this.cmd;

    agentCmd.action(() => {
      agentCmd.outputHelp();
    });

    agentCmd
      .command('status')
      .description('Show current agent status and coverage')
      .option('-j, --json', 'Output machine-readable JSON')
      .action(
        asyncHandler(async (opts: { json?: boolean }) => {
          await this.withContext(async (ctx) => {
            const sessions = ctx.kg.getAgentSessions();
            const touchedFiles = ctx.kg.getAgentTouchedFiles();
            const allFiles = ctx.kg.getAllFiles();

            const payload = {
              protocolVersion: 1,
              activeSessions: sessions.filter((s) => !s.endedAt).length,
              totalSessions: sessions.length,
              filesTouched: touchedFiles.length,
              totalFiles: allFiles.length,
              coverage: touchedFiles.length / Math.max(allFiles.length, 1),
              recentSessions: sessions.slice(0, 10),
              recentlyTouchedFiles: touchedFiles.slice(0, 10).map((f) => ({
                path: f.relativePath,
                agent: f.agentTouchedBy,
                touchedAt: f.agentTouchedAt,
              })),
            };

            if (opts.json) {
              output.json(payload);
              return;
            }

            output.section('Agent Status');
            output.kv('Active sessions', payload.activeSessions);
            output.kv('Total sessions', payload.totalSessions);
            output.kv('Files touched', payload.filesTouched);
            output.kv('Total files', payload.totalFiles);
            output.kv('Coverage', `${(payload.coverage * 100).toFixed(1)}%`);

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
      .option('-j, --json', 'Output machine-readable JSON')
      .action(
        asyncHandler(async (name: string, opts: { json?: boolean }) => {
          await this.withContext(async (ctx) => {
            const sessionId = ctx.kg.startAgentSession(name);
            if (opts.json) {
              output.json({ protocolVersion: 1, action: 'start', sessionId, agentName: name });
            } else {
              output.success(`Session started: ${name} (ID: ${sessionId})`);
            }
          });
        }),
      );

    agentCmd
      .command('end')
      .description('End an agent session')
      .argument('<id>', 'Session ID')
      .option('-j, --json', 'Output machine-readable JSON')
      .action(
        asyncHandler(async (id: string, opts: { json?: boolean }) => {
          await this.withContext(async (ctx) => {
            const sessionId = Number(id);
            if (!Number.isSafeInteger(sessionId) || sessionId <= 0) {
              throw new Error(`Session ID must be a positive integer: ${id}`);
            }
            if (!ctx.kg.endAgentSession(sessionId)) {
              if (opts.json) {
                output.json({
                  protocolVersion: 1,
                  action: 'end',
                  sessionId,
                  ended: false,
                  error: 'Session was not found or was already ended.',
                });
              } else {
                output.warn(`Session ${id} was not found or was already ended.`);
              }
              return;
            }
            if (opts.json)
              output.json({ protocolVersion: 1, action: 'end', sessionId, ended: true });
            else output.success(`Session ${id} ended.`);
          });
        }),
      );

    agentCmd
      .command('touch')
      .description('Mark a file as touched by an agent')
      .argument('<file>', 'File path')
      .option('-a, --agent <name>', 'Agent name', 'ai-agent')
      .option('-j, --json', 'Output machine-readable JSON')
      .action(
        asyncHandler(async (file: string, opts: { agent: string; json?: boolean }) => {
          await this.withContext(async (ctx) => {
            const absolutePath = confineToProject(file, loadConfig().projectRoot);
            const agent = opts.agent.trim();
            if (agent.length < 1 || agent.length > 200) {
              throw new Error('Agent name must contain 1–200 non-whitespace characters.');
            }
            await ctx.kg.markAgentTouched(absolutePath, agent);
            if (opts.json) {
              output.json({ protocolVersion: 1, action: 'touch', path: file, agent });
            } else {
              output.success(`Marked ${file} as touched by ${opts.agent}`);
            }
          });
        }),
      );

    agentCmd
      .command('coverage')
      .description('Show detailed agent coverage report')
      .option('-j, --json', 'Output machine-readable JSON')
      .action(
        asyncHandler(async (opts: { json?: boolean }) => {
          await this.withService(['scale'], async (_ctx, services) => {
            const scale = services.scale!;
            const report = scale.getScaleReport();

            if (opts.json) {
              output.json({
                protocolVersion: 1,
                overallCoverage: report.agentCoverage,
                modules: report.modules.map((mod) => ({
                  path: mod.path,
                  fileCount: mod.fileCount,
                  coverage: mod.agentCoverage,
                })),
                uncoveredHighLoadFiles: report.uncoveredFiles.slice(0, 10).map((f) => ({
                  path: f.relativePath,
                  cognitiveLoad: f.cognitiveLoad,
                })),
              });
              return;
            }

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
