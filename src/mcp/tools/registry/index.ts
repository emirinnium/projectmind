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
import { registerCliBridgeTool } from '../cli-bridge.js';
import { registerCliParityTools } from '../cli-parity.js';
import { annotateToolRegistration, shouldRegisterParityTools } from '../guard.js';

/**
 * Register all MCP tools - single entry point for tool registration.
 */
export async function registerAllTools(server: McpServer, deps: McpDependencies): Promise<void> {
  // Inject readOnly/idempotent hints into every dedicated read-only tool
  // registered below (single wrap point — no per-file edits needed).
  annotateToolRegistration(server);
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

  // CLI bridge — exposes the full CLI surface to agents that need a
  // capability without a dedicated tool (doctor, health, report, layers,
  // audit, license, sbom, churn, api-surface, dedup, heatmap, ownership,
  // adr, testgen, docgen, migrate, skill-recommend, context-budget,
  // contract-test generate/run, trace convert/show/clear, refactor-roi,
  // deps-fresh, flags, secrets-life, onboard, embed ...).
  registerCliBridgeTool(server, deps);

  // Auto-generated 1:1 CLI-parity tools (pm_<command>[_<sub>]).
  // Skipped when PROJECTMIND_TOOLS=core so clients with a small active-tool
  // budget (e.g. Cursor) get the dedicated surface (~45 tools) only.
  if (shouldRegisterParityTools()) {
    const parityCount = await registerCliParityTools(server, deps);
    console.info(`[mcp] dedicated tools + ${parityCount} CLI-parity tools registered`);
  } else {
    console.info('[mcp] PROJECTMIND_TOOLS=core — CLI-parity tools skipped (run_cli bridge still available)');
  }
}