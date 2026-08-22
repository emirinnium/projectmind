import { Command } from 'commander';
import { logger } from '@/cli/utils/logger.js';

export function createMcpCommand(): Command {
  return new Command('mcp')
    .description('Start ProjectMind as an MCP server (stdio mode)')
    .action(async () => {
      logger.setMcpMode(true);
      const { initMcpServer } = await import('../../mcp-server.js');
      await initMcpServer();
    });
}