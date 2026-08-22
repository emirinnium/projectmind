import { Command } from 'commander';
import { logger } from '@/cli/utils/logger.js';
import { asyncHandler } from '@/cli/utils/shared.js';

export function createMcpCommand(): Command {
  return new Command('mcp')
    .description('Start ProjectMind as an MCP server (stdio mode)')
    // asyncHandler ensures init failures surface as a clean CLI error
    // instead of an unhandled promise rejection escaping program.parse().
    .action(asyncHandler(async () => {
      logger.setMcpMode(true);
      const { initMcpServer } = await import('../../mcp-server.js');
      await initMcpServer();
    }));
}