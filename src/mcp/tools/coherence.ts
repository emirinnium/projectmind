import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from './types.js';
import { trackAgentAccess, validateMeta } from './types.js';

export function registerCheckCoherenceTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'check_coherence',
    {
      title: 'Check Code Coherence',
      description:
        "Check whether a code snippet matches the project's established patterns, naming conventions, and architectural rules.\n" +
        'Returns: verdict (pass/warn/fail), confidence, reasoning trace, actionable suggestions, plus optional import + reverse-dependency context.\n' +
        'WHEN to call: AFTER writing or editing a file, before commit, or when the user asks "is this consistent with the rest of the codebase?"\n' +
        'Use deep=true for LLM-based semantic analysis (requires API key for the configured provider); fast (default) is pattern-based and offline.\n' +
        'WHEN NOT to call: as a substitute for typecheck/lint; this checks pattern consistency, not correctness.',
      inputSchema: {
        code: z.string().describe('The code to analyze'),
        filePath: z.string().describe('Path of the file (for context resolution)'),
        deep: z
          .boolean()
          .default(false)
          .describe('Use deep LLM analysis instead of fast-pattern matching'),
        includeImports: z
          .boolean()
          .default(true)
          .describe('Include import/dependency analysis in coherence check'),
        includeDependents: z
          .boolean()
          .default(false)
          .describe('Include reverse dependency impact analysis'),
      },
    },
    async (args, { _meta }) => {
      try {
        // Optional envelope: only enforce the documented _meta shape when the
        // client actually advertises a protocolVersion (mirrors transport-edge
        // validateRequestMeta). Clients that send partial _meta pass through.
        if (
          _meta &&
          typeof _meta === 'object' &&
          typeof (_meta as { protocolVersion?: unknown }).protocolVersion === 'string'
        ) {
          validateMeta(_meta);
        }

        // Track agent access for coverage
        if (deps.agentName) {
          trackAgentAccess(deps.kg, deps.agentName, args.filePath);
        }

        const file = deps.kg.getFileByPath(args.filePath);
        const contextFiles = deps.kg.getAgentTouchedFiles().slice(0, 3);

        // Get import/dependency context
        let importContext = null;
        let dependentContext = null;

        if (file && args.includeImports) {
          const imports = deps.kg.getImportsWithDetails(file.id);
          const unresolvedImports = imports.filter((i) => !i.resolvedFile);
          importContext = {
            totalImports: imports.length,
            resolvedImports: imports.filter((i) => i.resolvedFile).length,
            unresolvedImports: unresolvedImports.map((i) => i.source),
            externalDependencies: imports
              .filter((i) => i.kind === 'import' && !i.resolvedFile)
              .map((i) => i.source),
            localDependencies: imports
              .filter((i) => i.resolvedFile)
              .map((i) => i.resolvedFile!.relativePath),
          };
        }

        if (file && args.includeDependents) {
          const dependents = deps.kg.getDependents(file.id);
          dependentContext = {
            directDependents: dependents.length,
            dependentFiles: dependents.map((d) => ({
              path: d.relativePath,
              cognitiveLoad: d.cognitiveLoad,
              agentTouched: d.agentTouched,
            })),
          };
        }

        const result = await deps.coherence.checkCoherence({
          code: args.code,
          filePath: args.filePath,
          contextFiles,
          deepAnalysis: args.deep,
          fastOnly: !args.deep,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  verdict: result.verdict,
                  confidence: result.confidence,
                  reasoningTrace: result.reasoningTrace,
                  suggestions: result.suggestions,
                  llmProvider: result.llmProvider,
                  responseTimeMs: result.responseTimeMs,
                  importContext,
                  dependentContext,
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
                  filePath: args.filePath,
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
