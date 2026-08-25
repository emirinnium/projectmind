import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from './types.js';

export function registerScanProjectTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'scan_project',
    {
      title: 'Scan Project',
      description:
        'Build or refresh the knowledge graph for the current project root (parses files, indexes imports, extracts patterns, computes cognitive load).\n' +
        'Returns: file count, scan errors, import resolution stats, optional circular dependencies, top hotspots.\n' +
        'WHEN to call: at the start of a session, after adding/renaming many files, or before running debt_report / genome_score / get_context.\n' +
        'It is INCREMENTAL: only files with a newer mtime than the last scan are re-parsed, so this is usually cheap.\n' +
        'WHEN NOT to call: between every single edit (use get_context + check_coherence instead). Pass full=true only when you suspect cache corruption.',
      inputSchema: {
        root: z.string().default('.').describe('Root directory to scan'),
        analyzeImports: z.boolean().default(true).describe('Analyze import/dependency relationships'),
        findCircularDeps: z.boolean().default(false).describe('Find circular dependencies after scan'),
      },
    },
    async (args) => {
      try {
        const result = await deps.scale.scanProject(args.root);
        const report = deps.scale.getScaleReport();

        let circularDeps: string[][] = [];
        const importStats = {
          totalImports: 0,
          resolvedImports: 0,
          unresolvedImports: 0,
          externalDependencies: 0,
        };

        if (args.analyzeImports) {
          const allFiles = deps.kg.getAllFiles();
          for (const file of allFiles) {
            const imports = deps.kg.getImportsWithDetails(file.id);
            importStats.totalImports += imports.length;
            importStats.resolvedImports += imports.filter((i) => i.resolvedFile).length;
            importStats.unresolvedImports += imports.filter((i) => !i.resolvedFile).length;
            importStats.externalDependencies += imports.filter((i) => i.kind === 'import' && !i.resolvedFile).length;
          }
        }

        if (args.findCircularDeps) {
          circularDeps = deps.kg.findCircularDependencies?.() || [];
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                scanned: result.scanned,
                errors: result.errors,
                totalFiles: report.totalFiles,
                agentCoverage: `${(report.agentCoverage * 100).toFixed(1)}%`,
                avgCognitiveLoad: report.avgCognitiveLoad,
                languages: report.languages,
                modules: report.modules.map((m) => ({
                  path: m.path,
                  fileCount: m.fileCount,
                  cognitiveLoad: m.cognitiveLoad,
                  agentCoverage: `${(m.agentCoverage * 100).toFixed(1)}%`,
                })),
                topHotspots: report.topHotspots.map((f) => ({
                  path: f.relativePath,
                  cognitiveLoad: f.cognitiveLoad,
                  agentTouched: f.agentTouched,
                })),
                uncoveredFiles: report.uncoveredFiles.map((f) => ({
                  path: f.relativePath,
                  cognitiveLoad: f.cognitiveLoad,
                })),
                importAnalysis: importStats,
                circularDependencies: circularDeps,
                circularDependencyCount: circularDeps.length,
              }, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : String(error),
              }, null, 2),
            },
          ],
        };
      }
    }
  );
}

export function registerStartSessionTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'start_session',
    {
      title: 'Start Agent Session',
      description: 'Start a new agent session for memory tracking.',
      inputSchema: {
        agentName: z.string().default('ai-agent').describe('Name of the AI agent'),
      },
    },
    async (args) => {
      try {
        const sessionId = deps.kg.startAgentSession(args.agentName);
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true, sessionId, agentName: args.agentName }) }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : String(error),
              }, null, 2),
            },
          ],
        };
      }
    }
  );
}

export function registerEndSessionTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'end_session',
    {
      title: 'End Agent Session',
      description: 'End an agent session.',
      inputSchema: {
        sessionId: z.number().describe('Session ID to end'),
      },
    },
    async (args) => {
      try {
        deps.kg.endAgentSession(args.sessionId);
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true, status: 'ended', sessionId: args.sessionId }) }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : String(error),
              }, null, 2),
            },
          ],
        };
      }
    }
  );
}

export function registerGetAgentSessionsTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'get_agent_sessions',
    {
      title: 'Get Agent Sessions',
      description: 'Get all agent sessions.',
      inputSchema: {
        agentName: z.string().optional().describe('Filter by agent name'),
        limit: z.number().default(50).describe('Maximum number of sessions to return'),
      },
    },
    async (args) => {
      try {
        const sessions = deps.kg.getAgentSessions(args.agentName, args.limit);
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true, sessions }) }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : String(error),
              }, null, 2),
            },
          ],
        };
      }
    }
  );
}