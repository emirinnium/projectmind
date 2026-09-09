import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from './types.js';
import { createProgressReporter } from './progress.js';
import { confineToProject } from './_shared.js';
import { resolve } from 'node:path';

export function registerScanProjectTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'scan_project',
    {
      title: 'Scan Project',
      description:
        'Build or refresh the knowledge graph for the current project root (parses files, indexes imports, extracts patterns, computes cognitive load).\n' +
        'Returns: file count, scan errors, import resolution stats, optional circular dependencies, top hotspots.\n' +
        'WHEN to call: at the start of a session, after adding/renaming many files, or before running debt_report / genome_score / get_context.\n' +
        'It is INCREMENTAL: bounded source files are re-hashed and only files whose content hash changed since the last scan are re-parsed, so this is usually cheap and remains correct across restored or preserved mtimes.\n' +
        'WHEN NOT to call: between every single edit (use get_context + check_coherence instead). Pass full=true only when you suspect cache corruption or need to rebuild every indexed file.',
      inputSchema: {
        root: z.string().default('.').describe('Root directory to scan'),
        analyzeImports: z
          .boolean()
          .default(true)
          .describe('Analyze import/dependency relationships'),
        findCircularDeps: z
          .boolean()
          .default(false)
          .describe('Find circular dependencies after scan'),
        full: z
          .boolean()
          .default(false)
          .describe('Force full scan (bypass incremental content-hash comparison)'),
      },
    },
    async (args, extra) => {
      const progress = createProgressReporter(extra, 'scan_project');
      try {
        await progress(5, 100, 'scan starting');
        // Full profile (duration/files-per-sec/memory) + persisted scan row.
        // Honors args.full, previously accepted-but-ignored by this tool.
        const scanRoot = resolveProjectRoot(args.root, deps.projectRoot);
        const result = await deps.scale.scanProjectWithProfile(scanRoot, args.full);
        const report = deps.scale.getScaleReport();
        await progress(40, 100, `scanned ${result.scannedFiles} files, analyzing imports`);

        let circularDeps: string[][] = [];
        const importStats = {
          totalImports: 0,
          resolvedImports: 0,
          unresolvedImports: 0,
          externalDependencies: 0,
        };

        if (args.analyzeImports) {
          const allFiles = deps.kg.getAllFiles();
          for (const [i, file] of allFiles.entries()) {
            const imports = deps.kg.getImportsWithDetails(file.id);
            importStats.totalImports += imports.length;
            importStats.resolvedImports += imports.filter((i) => i.resolvedFile).length;
            importStats.unresolvedImports += imports.filter((i) => !i.resolvedFile).length;
            importStats.externalDependencies += imports.filter(
              (i) => !i.resolvedFile && isExternalImport(i.source),
            ).length;
            // Progress during the per-file import analysis pass (throttled
            // internally; cheap no-op when client did not request progress).
            if (i % 250 === 0 && allFiles.length > 0) {
              await progress(
                40 + Math.round((i / allFiles.length) * 40),
                100,
                `import analysis ${i}/${allFiles.length}`,
              );
            }
          }
        }
        await progress(85, 100, 'import analysis complete');

        if (args.findCircularDeps) {
          circularDeps = deps.kg.findCircularDependencies?.() || [];
        }
        await progress(100, 100, `done: ${result.scannedFiles} files`);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  scanned: result.scannedFiles,
                  errors: result.errorFiles,
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
                  scanStats: {
                    durationMs: result.durationMs,
                    filesPerSecond: result.filesPerSecond,
                    memoryUsedMB: result.memoryUsedMB,
                  },
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: false,
                  error: error instanceof Error ? error.message : String(error),
                },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );
}

export function registerStartSessionTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'start_session',
    {
      title: 'Start Agent Session',
      description: 'Start a new agent session for memory tracking.',
      inputSchema: {
        agentName: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .default('ai-agent')
          .describe('Name of the AI agent'),
      },
    },
    async (args) => {
      try {
        const sessionId = deps.kg.startAgentSession(args.agentName);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success: true, sessionId, agentName: args.agentName }),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: false,
                  error: error instanceof Error ? error.message : String(error),
                },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );
}

export function registerEndSessionTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'end_session',
    {
      title: 'End Agent Session',
      description: 'End an agent session.',
      inputSchema: {
        sessionId: z.number().int().positive().describe('Session ID to end'),
      },
    },
    async (args) => {
      try {
        const ended = deps.kg.endAgentSession(args.sessionId);
        if (!ended) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  error: `Agent session ${args.sessionId} was not found or was already ended.`,
                }),
              },
            ],
          };
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success: true, status: 'ended', sessionId: args.sessionId }),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: false,
                  error: error instanceof Error ? error.message : String(error),
                },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );
}

export function registerGetAgentSessionsTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'get_agent_sessions',
    {
      title: 'Get Agent Sessions',
      description: 'Get all agent sessions.',
      inputSchema: {
        agentName: z.string().trim().min(1).max(200).optional().describe('Filter by agent name'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .default(50)
          .describe('Maximum number of sessions to return'),
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
              text: JSON.stringify(
                {
                  success: false,
                  error: error instanceof Error ? error.message : String(error),
                },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );
}

function isExternalImport(source: string): boolean {
  return !source.startsWith('.') && !source.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(source);
}

function resolveProjectRoot(root: string, activeRoot: string): string {
  const normalized = root.trim();
  if (normalized === '' || normalized === '.') return activeRoot;
  const candidate = confineToProject(normalized, activeRoot);
  const candidateRoot = resolve(candidate);
  const activeProjectRoot = resolve(activeRoot);
  const sameRoot =
    process.platform === 'win32'
      ? candidateRoot.toLowerCase() === activeProjectRoot.toLowerCase()
      : candidateRoot === activeProjectRoot;
  if (!sameRoot) {
    throw new Error(
      'scan_project indexes the active project root only; switch projects before scanning a different root.',
    );
  }
  return activeRoot;
}
