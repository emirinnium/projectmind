import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from './types.js';
import { trackAgentAccess } from './types.js';

export function registerCheckCoherenceTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'check_coherence',
    {
      title: 'Check Code Coherence',
      description: 'Check code coherence against project patterns. Can detect pattern drift, architectural inconsistency, and style violations.',
      inputSchema: {
        code: z.string().describe('The code to analyze'),
        filePath: z.string().describe('Path of the file (for context resolution)'),
        deep: z.boolean().default(false).describe('Use deep LLM analysis instead of fast-pattern matching'),
        includeImports: z.boolean().default(true).describe('Include import/dependency analysis in coherence check'),
        includeDependents: z.boolean().default(false).describe('Include reverse dependency impact analysis'),
      },
    },
    async (args) => {
      try {
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
            externalDependencies: imports.filter((i) => i.kind === 'import' && !i.resolvedFile).map((i) => i.source),
            localDependencies: imports.filter((i) => i.resolvedFile).map((i) => i.resolvedFile!.relativePath),
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
              text: JSON.stringify({
                success: true,
                verdict: result.verdict,
                confidence: result.confidence,
                reasoningTrace: result.reasoningTrace,
                suggestions: result.suggestions,
                llmProvider: result.llmProvider,
                responseTimeMs: result.responseTimeMs,
                importContext,
                dependentContext,
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
                filePath: args.filePath,
              }, null, 2),
            },
          ],
        };
      }
    }
  );
}