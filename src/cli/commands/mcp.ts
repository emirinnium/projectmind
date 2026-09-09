import { Command } from 'commander';
import { logger } from '@/cli/utils/logger.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAllTools } from '@/mcp/tools/registry/index.js';
import { registerResourceSubscriptionTool } from '@/mcp/resources.js';
import { exportRegisteredToolSchemas } from '@/mcp/tools/schema-export.js';
import { stopPeriodicCleanup } from '@/mcp/tools/locks.js';

export function createMcpCommand(): Command {
  const command = new Command('mcp')
    .description('Start ProjectMind as an MCP server (stdio mode)')
    .option('--profile <profile>', 'Tool profile: core|review|security|maintenance|full', 'core')
    // Deliberately NOT wrapped in asyncHandler: the long-running stdio
    // server must keep the process alive after initialization.
    .action(async (opts: { profile: string }) => {
      try {
        if (!['core', 'review', 'security', 'maintenance', 'full'].includes(opts.profile)) {
          throw new Error('--profile must be core, review, security, maintenance, or full.');
        }
        process.env.PROJECTMIND_TOOLS = opts.profile;
        logger.setMcpMode(true);
        const { initMcpServer } = await import('../../mcp-server.js');
        await initMcpServer();
      } catch (error) {
        logger.error(
          `Failed to start MCP server: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      }
    });
  command
    .command('schemas')
    .description('Export the registered runtime Zod schemas as JSON Schema')
    .option('--profile <profile>', 'Tool profile: core|review|security|maintenance|full', 'core')
    .action(async (opts: { profile: string }) => {
      const profiles = ['core', 'review', 'security', 'maintenance', 'full'];
      // Commander may bind an option placed after the subcommand to the
      // parent command when both levels expose --profile. Prefer an explicit
      // child value, otherwise honor the parent value so `mcp --profile full
      // schemas` and `mcp schemas --profile full` have identical behavior.
      const inheritedProfile = command.opts<{ profile?: string }>().profile;
      const selectedProfile =
        opts.profile === 'core' && inheritedProfile && inheritedProfile !== 'core'
          ? inheritedProfile
          : opts.profile;
      if (!profiles.includes(selectedProfile))
        throw new Error('--profile must be core, review, security, maintenance, or full.');
      const previousProfile = process.env.PROJECTMIND_TOOLS;
      process.env.PROJECTMIND_TOOLS = selectedProfile;
      logger.setMachineMode(true);
      try {
        const server = new McpServer({ name: 'projectmind-schema-export', version: '1.0.0' });
        await registerAllTools(server, {} as never);
        registerResourceSubscriptionTool(server);
        process.stdout.write(`${JSON.stringify(exportRegisteredToolSchemas(server), null, 2)}\n`);
      } finally {
        stopPeriodicCleanup();
        logger.setMachineMode(false);
        if (previousProfile === undefined) delete process.env.PROJECTMIND_TOOLS;
        else process.env.PROJECTMIND_TOOLS = previousProfile;
      }
    });
  return command;
}
