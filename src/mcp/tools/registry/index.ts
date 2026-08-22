import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from '../types.js';
import { registerCheckCoherenceTool } from '../coherence.js';
import { registerGetContextTool } from '../context.js';
import { registerStoreMemoryTool, registerGetMemoryTool } from '../memory.js';
import { registerDebtReportTool, registerScaleReportTool, registerGenomeScoreTool } from '../reports.js';
import { registerScanProjectTool, registerStartSessionTool, registerEndSessionTool, registerGetAgentSessionsTool } from '../project.js';
import { registerTraceImportsTool, registerFindCircularDepsTool, registerResolveImportTool, registerGetDependentsTool, registerGetDependencyGraphTool } from '../imports.js';
import { registerResolvePathTool, registerFindFileByImportTool } from '../paths.js';
import { registerCheckArchitectureTool, registerAnalyzeImpactTool, registerSuggestRefactorTool } from '../architecture.js';
import { registerFileWatchTool, registerGetFileStatusTool, registerSyncContextTool, registerUnregisterFileWatchTool } from '../sync.js';
import { registerIngestTraceTool } from '../trace.js';
import { registerStructuralSearchTool } from '../structural-search.js';
import { registerProjectTools } from '../projects.js';
import { registerDataFlowTools } from '../data-flow.js';
import { registerEmbeddingTools } from '../embeddings.js';
import { registerTaintTools } from '../taint.js';
import { registerTeamMemoryTools } from '../team-memory.js';

/**
 * Register all MCP tools - single entry point for tool registration.
 */
export function registerAllTools(server: McpServer, deps: McpDependencies): void {
  // Core tools
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

  // Import/Dependency analysis tools
  registerTraceImportsTool(server, deps);
  registerFindCircularDepsTool(server, deps);
  registerResolveImportTool(server, deps);
  registerGetDependentsTool(server, deps);
  registerGetDependencyGraphTool(server, deps);

  // Path resolution tools
  registerResolvePathTool(server, deps);
  registerFindFileByImportTool(server, deps);

  // Architecture/Impact analysis tools
  registerCheckArchitectureTool(server, deps);
  registerAnalyzeImpactTool(server, deps);
  registerSuggestRefactorTool(server, deps);

  // Continuous sync tools
  registerFileWatchTool(server, deps);
  registerGetFileStatusTool(server, deps);
  registerSyncContextTool(server, deps);
  registerUnregisterFileWatchTool(server, deps);

  // Dynamic tracing tools
  registerIngestTraceTool(server, deps);

  // Structural search/replace tools
  registerStructuralSearchTool(server, deps);

  // Project management tools
  registerProjectTools(server, deps);

  // Data-flow analysis tools
  registerDataFlowTools(server, deps);

  // Embedding tools
  registerEmbeddingTools(server, deps);

  // Taint analysis tools
  registerTaintTools(server, deps);

  // Team memory tools
  registerTeamMemoryTools(server, deps);
}