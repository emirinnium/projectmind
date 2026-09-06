import { Command } from 'commander';
import { logger } from '@/cli/utils/logger.js';

export function createMcpCommand(): Command {
  return (
    new Command('mcp')
      .description('Start ProjectMind as an MCP server (stdio mode)')
      // Deliberately NOT wrapped in asyncHandler: the long-running stdio
      // server must keep the process alive after initialization.
      .action(async () => {
        try {
          logger.setMcpMode(true);
          const { initMcpServer } = await import('../../mcp-server.js');
          await initMcpServer();
        } catch (error) {
          logger.error(
            `Failed to start MCP server: ${error instanceof Error ? error.message : String(error)}`,
          );
          throw error;
        }
      })
  );
}
