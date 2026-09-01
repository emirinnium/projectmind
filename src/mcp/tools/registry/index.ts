import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from '../types.js';
import { registerCheckCoherenceTool } from '../coherence.js';
import { registerKgStatsTool } from '../kg-stats.js';
import { registerGetContextTool } from '../context.js';
import { registerStoreMemoryTool, registerGetMemoryTool } from '../memory.js';
import {
  registerDebtReportTool,
  registerScaleReportTool,
  registerGenomeScoreTool,
} from '../reports.js';
import {
  registerScanProjectTool,
  registerStartSessionTool,
  registerEndSessionTool,
  registerGetAgentSessionsTool,
} from '../project.js';
import {
  registerTraceImportsTool,
  registerFindCircularDepsTool,
  registerResolveImportTool,
  registerGetDependentsTool,
  registerGetDependencyGraphTool,
} from '../imports.js';
import { registerGraphQueryTool } from '../graph.js';
import { registerExportArchitectureDiagramTool } from '../architecture-diagram.js';
import { registerResolvePathTool, registerFindFileByImportTool } from '../paths.js';
import {
  registerCheckArchitectureTool,
  registerAnalyzeImpactTool,
  registerSuggestRefactorTool,
} from '../architecture.js';
import { registerCheckContractsTool } from '../contracts.js';
import { registerAutoFixTool } from '../auto-fix.js';
import {
  registerFileWatchTool,
  registerGetFileStatusTool,
  registerSyncContextTool,
  registerUnregisterFileWatchTool,
} from '../sync.js';
import { registerAgentLocksTool } from '../locks.js';
import { registerPredictMergeRiskTool } from '../merge-risk.js';
import { registerPredictImpactRiskTool } from '../impact.js';
import { registerIngestTraceTool } from '../trace.js';
import { registerStructuralSearchTool } from '../structural-search.js';
import { registerProjectTools } from '../projects.js';
import { registerDataFlowTools } from '../data-flow.js';
import { registerEmbeddingTools } from '../embeddings.js';
import { registerTaintTools } from '../taint.js';
import { registerTeamMemoryTools } from '../team-memory.js';
import { registerCliBridgeTool } from '../cli-bridge.js';
import { registerCliParityTools } from '../cli-parity.js';
import { registerScanCvesTool } from '../scan-cves.js';
import { registerIntelligenceTools } from '../intelligence.js';
import { registerSemanticSearchTool } from '../semantic-search.js';
import { registerFindSymbolReferencesTool } from '../symbol-refs.js';
import { registerFindSymbolDefinitionTool } from '../symbol-def.js';
import { registerSuggestNextFilesTool } from '../smart-context.js';
import { registerRecommendSkillsTool } from '../skill-recommend.js';
import { annotateToolRegistration, shouldRegisterParityTools } from '../guard.js';
import { logger } from '../../../utils/logger.js';

/**
 * Register all MCP tools - single entry point for tool registration.
 */
export async function registerAllTools(server: McpServer, deps: McpDependencies): Promise<void> {
  // Single wrap point for every tool registered below (no per-file edits
  // needed): injects readOnly/idempotent annotations into dedicated read-only
  // tools AND spreads toolCacheHintMeta(name) `_meta` cache hints
  // (ttlMs/cacheScope) into every tool config — the documented cache-hint
  // feature (src/mcp/tools/list.ts) now applies to tools, not just resources.
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

  // Graph algorithms (PageRank, communities, subgraph, shortest path)
  registerGraphQueryTool(server, deps);

  // Knowledge graph statistics (nodes, edges, top PageRank)
  registerKgStatsTool(server, deps);

  // Architecture diagram export (SVG/PNG/Mermaid) — render the live module landscape
  registerExportArchitectureDiagramTool(server, deps);

  // Path resolution tools
  registerResolvePathTool(server, deps);
  registerFindFileByImportTool(server, deps);

  // Architecture/Impact analysis tools
  registerCheckArchitectureTool(server, deps);
  registerAnalyzeImpactTool(server, deps);
  registerSuggestRefactorTool(server, deps);

  // Architectural contract enforcement (ContractEngine over files/repo)
  registerCheckContractsTool(server, deps);

  // AST-safe auto-fix (preview-first; writes only when apply:true)
  registerAutoFixTool(server, deps);

  // Continuous sync tools
  registerFileWatchTool(server, deps);
  registerGetFileStatusTool(server, deps);
  registerSyncContextTool(server, deps);
  registerUnregisterFileWatchTool(server, deps);

  // Multi-agent coordination (advisory file locks)
  registerAgentLocksTool(server, deps);

  // Multi-agent coordination (merge-collision prediction before edits)
  registerPredictMergeRiskTool(server, deps);

  // Predictive impact alerting with risk levels (low/medium/high/critical)
  registerPredictImpactRiskTool(server, deps);

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

  // WP8 capability tools (F38): intent search, predictive impact, context
  // budget planning, KG integrity, intent broadcast + conflict checks,
  // cross-project patterns.
  registerIntelligenceTools(server, deps);

  // Pure semantic file search over stored embeddings.
  registerSemanticSearchTool(server, deps);

  // Symbol-level cross-reference via the real TypeScript language service.
  registerFindSymbolReferencesTool(server, deps);

  // Go-to-definition via the real TypeScript language service.
  registerFindSymbolDefinitionTool(server, deps);

  // Task-aware "what to read next" ranking over the knowledge graph
  // (direct/transitive dependents + semantic neighbors + task keywords).
  registerSuggestNextFilesTool(server, deps);

  // Skill recommendations from the skills registry for a task description.
  registerRecommendSkillsTool(server, deps);

  // CLI bridge — exposes the full CLI surface to agents that need a
  // capability without a dedicated tool (doctor, health, report, layers,
  // audit, license, sbom, churn, api-surface, dedup, heatmap, ownership,
  // adr, testgen, docgen, migrate, skill-recommend, context-budget,
  // contract-test generate/run, trace convert/show/clear, refactor-roi,
  // deps-fresh, flags, secrets-life, onboard, embed ...).
  registerCliBridgeTool(server, deps);

  // Auto-generated 1:1 CLI-parity tools (pm_<command>[_<sub>]).
  // Registered when PROJECTMIND_TOOLS=all. Default is `core` (~45 tools)
  // for clients with a small active-tool budget (e.g. Cursor).
  if (shouldRegisterParityTools()) {
    const parityCount = await registerCliParityTools(server, deps);
    logger.info(
      `[mcp] dedicated tools + ${parityCount} CLI-parity tools registered (PROJECTMIND_TOOLS=all)`,
    );
  } else {
    logger.info(
      '[mcp] PROJECTMIND_TOOLS=core (default) — CLI-parity tools skipped. Set PROJECTMIND_TOOLS=all for full surface. run_cli bridge still available.',
    );
  }

  // Security analysis tools
  registerScanCvesTool(server, deps);
}
