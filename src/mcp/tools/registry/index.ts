import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from '../types.js';
import { registerCheckCoherenceTool } from '../coherence.js';
import { registerGetContextTool } from '../context.js';
import { registerStoreMemoryTool, registerGetMemoryTool } from '../memory.js';
import { registerDebtReportTool, registerScaleReportTool, registerGenomeScoreTool } from '../reports.js';
import { registerScanProjectTool, registerStartSessionTool, registerEndSessionTool, registerGetAgentSessionsTool } from '../project.js';

/**
 * Register all MCP tools
 */
export function registerAllTools(server: McpServer, deps: McpDependencies): void {
  registerCheckCoherenceTool(server, deps);
  registerGetContextTool(server, deps);
  registerStoreMemoryTool(server, deps);
  registerGetMemoryTool(server, deps);
  registerDebtReportTool(server, deps);
  registerScaleReportTool(server, deps);
  registerGenomeScoreTool(server, deps);
  registerScanProjectTool(server, deps);
  registerStartSessionTool(server, deps);
  registerEndSessionTool(server, deps);
  registerGetAgentSessionsTool(server, deps);
}