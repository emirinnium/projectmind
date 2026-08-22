import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from './types.js';
import { trackAgentAccess } from './types.js';
import { TaintAnalyzer } from '@/parser/taint-analyzer.js';

export function registerTaintTools(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'analyze_taint',
    {
      title: 'Analyze Taint',
      description: 'Analyze a TypeScript/JavaScript file for taint flows from sources to sinks using AST patterns.',
      inputSchema: {
        filePath: z.string().describe('Path to the file to analyze'),
      },
    },
    async (args) => {
      try {
        if (deps.agentName) {
          trackAgentAccess(deps.kg, deps.agentName, 'taint-analyze');
        }

        const analyzer = new TaintAnalyzer(deps.kg);
        const { readFileSync, existsSync } = await import('node:fs');

        if (!existsSync(args.filePath)) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: `File not found: ${args.filePath}` }, null, 2) }],
          };
        }

        const content = readFileSync(args.filePath, 'utf-8');
        const lang = args.filePath.endsWith('.ts') || args.filePath.endsWith('.tsx') ? 'typescript' : 'javascript';
        const flows = analyzer.analyzeSource(args.filePath, content, lang);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                filePath: args.filePath,
                flows: flows.map((f) => ({
                  source: f.source.qualifiedName,
                  sink: f.sink.qualifiedName,
                  kind: f.source.kind,
                  viaFunction: f.viaFunction,
                })),
                count: flows.length,
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

  server.registerTool(
    'record_taint',
    {
      title: 'Record Taint',
      description: 'Analyze a TypeScript/JavaScript file and record detected taint flows to the knowledge graph.',
      inputSchema: {
        filePath: z.string().describe('Path to the file to analyze'),
      },
    },
    async (args) => {
      try {
        if (deps.agentName) {
          trackAgentAccess(deps.kg, deps.agentName, 'taint-record');
        }

        const analyzer = new TaintAnalyzer(deps.kg);
        const { readFileSync, existsSync } = await import('node:fs');

        if (!existsSync(args.filePath)) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: `File not found: ${args.filePath}` }, null, 2) }],
          };
        }

        const content = readFileSync(args.filePath, 'utf-8');
        const lang = args.filePath.endsWith('.ts') || args.filePath.endsWith('.tsx') ? 'typescript' : 'javascript';
        const recorded = analyzer.recordFlows(args.filePath, content, lang);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                filePath: args.filePath,
                recorded,
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
