import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from './types.js';
import { trackAgentAccess } from './types.js';
import {
  attachEvidence,
  buildEvidencePacket,
  verifyProjectFreshness,
} from '../../core/proof/evidence.js';

interface TraceFunctionLocation {
  functionName: string;
  filePath: string;
  lineStart: number | null;
  lineEnd: number | null;
}

function findFunctionLocations(
  deps: McpDependencies,
  functionNames: string[],
): TraceFunctionLocation[] {
  const names = [...new Set(functionNames)].filter((name) => name.length > 0);
  if (names.length === 0) return [];
  const placeholders = names.map(() => '?').join(', ');
  const rows = deps.kg.db
    .prepare(
      `SELECT fn.name AS function_name, f.relative_path AS file_path,
              fn.start_line AS line_start, fn.end_line AS line_end
       FROM functions fn
       JOIN files f ON f.id = fn.file_id
       WHERE f.project_id = ? AND fn.name IN (${placeholders})
       ORDER BY fn.name, f.relative_path`,
    )
    .all(deps.kg.getCurrentProjectId(), ...names) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    functionName: typeof row.function_name === 'string' ? row.function_name : '',
    filePath: typeof row.file_path === 'string' ? row.file_path : '',
    lineStart: typeof row.line_start === 'number' ? row.line_start : null,
    lineEnd: typeof row.line_end === 'number' ? row.line_end : null,
  }));
}

export function registerIngestTraceTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'ingest_trace',
    {
      title: 'Ingest Runtime Trace',
      description:
        'Ingest runtime call trace data into the knowledge graph. Returns workload accounting, function locations, unresolved names, source freshness, and explicit limits of the runtime evidence.',
      inputSchema: {
        traceData: z
          .array(
            z.object({
              fromFunctionName: z.string().trim().min(1).max(500),
              toFunctionName: z.string().trim().min(1).max(500),
              workloadId: z.string().trim().min(1).max(200),
              callCount: z.number().int().positive().max(1_000_000_000).optional(),
              staticMissed: z.boolean().optional(),
            }),
          )
          .max(10_000)
          .describe('Array of trace events from runtime execution'),
        workloadId: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe('Workload identifier for grouping trace data'),
        clear: z.boolean().default(false).describe('Clear existing dynamic calls before ingest'),
      },
    },
    async (args) => {
      try {
        if (deps.agentName) {
          trackAgentAccess(deps.kg, deps.agentName, 'trace-ingest');
        }

        const workloadId = args.workloadId || `trace-${Date.now()}`;
        const functionNames = args.traceData.flatMap((call) => [
          call.fromFunctionName,
          call.toFunctionName,
        ]);
        const knownLocations = findFunctionLocations(deps, functionNames);

        if (args.clear) {
          deps.kg.clearDynamicCalls(workloadId);
        }

        const result = deps.kg.ingestDynamicCalls(
          args.traceData.map((c) => ({
            ...c,
            workloadId: c.workloadId || workloadId,
          })),
        );

        const knownNames = new Set(knownLocations.map((location) => location.functionName));
        const unresolvedFunctionNames = [...new Set(functionNames)].filter(
          (name) => !knownNames.has(name),
        );
        const evidencePaths = [
          ...new Set(knownLocations.map((location) => location.filePath)),
        ].filter((path) => path.length > 0);
        const freshness = await verifyProjectFreshness(deps.kg, deps.projectRoot, evidencePaths);
        const evidence = buildEvidencePacket(freshness, {
          evidence: knownLocations.map((location) => ({
            filePath: location.filePath,
            kind: 'runtime' as const,
            relation: `${location.functionName} observed in ${workloadId}`,
            lineStart: location.lineStart ?? undefined,
            lineEnd: location.lineEnd ?? undefined,
            note: 'Function location was resolved from the indexed graph before trace ingestion.',
          })),
          runtimeVerified: result.errors.length === 0 && result.inserted + result.updated > 0,
          limitations: [
            'A trace proves that the supplied workload emitted these events; it does not prove all possible runtime paths or input outcomes.',
            ...(unresolvedFunctionNames.length > 0
              ? [
                  `${unresolvedFunctionNames.length} function name(s) were not present before ingestion and need source-level mapping.`,
                ]
              : []),
          ],
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                attachEvidence(
                  {
                    success: true,
                    workloadId,
                    inserted: result.inserted,
                    updated: result.updated,
                    errors: result.errors,
                    totalProcessed: result.inserted + result.updated,
                    traceCoverage: {
                      eventsReceived: args.traceData.length,
                      eventsPersisted: result.inserted + result.updated,
                      rejectedEvents: result.errors.length,
                      functionsObserved: [...new Set(functionNames)].length,
                      resolvedFunctionNames: knownNames.size,
                      unresolvedFunctionNames,
                      functionLocations: knownLocations,
                    },
                    nextAction:
                      result.errors.length > 0 || unresolvedFunctionNames.length > 0
                        ? 'Review rejected events and unresolved function names before using this trace for impact decisions.'
                        : 'Use trace show --workload-id to inspect observed edges; rerun after source changes to keep runtime evidence current.',
                  },
                  evidence,
                ),
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
