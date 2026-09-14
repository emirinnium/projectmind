import { Command } from 'commander';
import { logger } from '@/cli/utils/logger.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAllTools } from '@/mcp/tools/registry/index.js';
import { registerResourceSubscriptionTool } from '@/mcp/resources.js';
import { exportRegisteredToolSchemas } from '@/mcp/tools/schema-export.js';
import { stopPeriodicCleanup } from '@/mcp/tools/locks.js';
import { MCP_PROFILE_NAMES, normalizeMcpProfile } from '@/mcp/tools/guard.js';
import { currentModuleDir, resolvePackageVersion } from '@/utils/version.js';

const profileHelp = `${MCP_PROFILE_NAMES.join('|')} (all is an alias for full)`;

function parseProfile(value: string): ReturnType<typeof normalizeMcpProfile> {
  const profile = normalizeMcpProfile(value);
  if (!profile) throw new Error(`--profile must be ${profileHelp}.`);
  return profile;
}

export function createMcpCommand(): Command {
  const command = new Command('mcp')
    .description('Start ProjectMind as an MCP server (stdio mode)')
    .option('--profile <profile>', `Tool profile: ${profileHelp}`, 'core')
    // Deliberately NOT wrapped in asyncHandler: the long-running stdio
    // server must keep the process alive after initialization.
    .action(async (opts: { profile: string }) => {
      try {
        process.env.PROJECTMIND_TOOLS = parseProfile(opts.profile) ?? 'core';
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
    .alias('schema')
    .description('Export the registered runtime Zod schemas as JSON Schema')
    .option('--profile <profile>', `Tool profile: ${profileHelp}`, 'core')
    .action(async (opts: { profile: string }) => {
      // Commander may bind an option placed after the subcommand to the
      // parent command when both levels expose --profile. Prefer an explicit
      // child value, otherwise honor the parent value so `mcp --profile full
      // schemas` and `mcp schemas --profile full` have identical behavior.
      const inheritedProfile = command.opts<{ profile?: string }>().profile;
      const selectedProfile =
        opts.profile === 'core' && inheritedProfile && inheritedProfile !== 'core'
          ? inheritedProfile
          : opts.profile;
      const normalizedSelectedProfile = parseProfile(selectedProfile);
      const previousProfile = process.env.PROJECTMIND_TOOLS;
      process.env.PROJECTMIND_TOOLS = normalizedSelectedProfile ?? 'core';
      logger.setMachineMode(true);
      try {
        const server = new McpServer({
          name: 'projectmind-schema-export',
          version: resolvePackageVersion(currentModuleDir(import.meta.url)),
        });
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
