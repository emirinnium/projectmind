import { Command } from 'commander';
import { logger } from '@/cli/utils/logger.js';

export function createMcpCommand(): Command {
  return new Command('mcp')
    .description('Start ProjectMind as an MCP server (stdio mode)')
    // Deliberately NOT wrapped in asyncHandler: it calls process.exit(0) on
    // success, which killed the long-running stdio server the moment it
    // became ready. Errors are handled explicitly with exit(1) instead;
    // success falls through to stdin.resume inside the server module.
    .action(async () => {
      try {
        logger.setMcpMode(true);
        const { initMcpServer } = await import('../../mcp-server.js');
        await initMcpServer();
      } catch (error) {
        logger.error(`Failed to start MCP server: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });
}