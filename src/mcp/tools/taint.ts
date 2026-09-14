import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from './types.js';
import { trackAgentAccess } from './types.js';
import { TaintAnalyzer } from '@/parser/taint-analyzer.js';
import { detectLanguageFromPath } from '@/parser/language-service.js';
import { assertProjectPath } from './_shared.js';
import { buildExploitPathReport } from '@/core/predictive/exploit-path.js';
import { actionableError, actionableMcpError } from '@/utils/actionable-error.js';

function unsupportedLanguageError(operation: string): ReturnType<typeof actionableMcpError> {
  return actionableMcpError(
    actionableError(
      'taint.unsupported-language',
      `${operation} supports only TypeScript and JavaScript files.`,
      ['Use a .ts, .tsx, .js, or .jsx project-relative file and retry.'],
      { cause: 'unsupported', retryable: false },
    ),
  );
}

export function registerTaintTools(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'analyze_taint',
    {
      title: 'Analyze Taint',
      description:
        'Analyze a TypeScript or JavaScript file for taint flows from sources to sinks using AST patterns.',
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
        const { readFile } = await import('node:fs/promises');

        // K5: validate existence and the single .pmignore boundary before reading.
        const absPath = assertProjectPath(args.filePath, deps.projectRoot, {
          mustExist: true,
          rejectIgnored: true,
        });
        const content = await readFile(absPath, 'utf-8');
        const lang = detectLanguageFromPath(absPath);
        if (!lang) {
          return unsupportedLanguageError('Taint analysis');
        }
        const flows = analyzer.analyzeSource(absPath, content, lang);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  filePath: args.filePath,
                  flows: flows.map((f) => ({
                    source: f.source.qualifiedName,
                    sink: f.sink.qualifiedName,
                    kind: f.source.kind,
                    viaFunction: f.viaFunction,
                    sanitizedByKnownFunction: f.sanitized === true,
                    evidenceSteps: f.path.map((step) => step.type),
                  })),
                  count: flows.length,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return actionableMcpError(error);
      }
    },
  );

  server.registerTool(
    'exploit_path',
    {
      title: 'Taint-to-Exploit Path',
      description:
        'Report statically reachable source-to-sink taint paths with line locations and safe reproduction guidance. Set includeProject to follow bounded resolved imports into named exported functions. This is a candidate path, not proof of a vulnerability; no code, command, credential, or network request is executed.',
      inputSchema: {
        filePath: z.string().describe('Path to the TypeScript or JavaScript file to analyze'),
        includeProject: z
          .boolean()
          .optional()
          .default(false)
          .describe('Follow bounded statically resolved project imports'),
      },
    },
    async (args) => {
      try {
        const absPath = assertProjectPath(args.filePath, deps.projectRoot, {
          mustExist: true,
          rejectIgnored: true,
        });
        const { readFile } = await import('node:fs/promises');
        const content = await readFile(absPath, 'utf-8');
        const lang = detectLanguageFromPath(absPath);
        if (!lang) {
          return unsupportedLanguageError('Exploit-path analysis');
        }
        const analyzer = new TaintAnalyzer(deps.kg);
        const projectAnalysis = args.includeProject ? analyzer.analyzeProject(absPath) : undefined;
        const flows = projectAnalysis?.localFlows ?? analyzer.analyzeSource(absPath, content, lang);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  ...buildExploitPathReport(
                    args.filePath,
                    flows,
                    projectAnalysis?.interFileFlows ?? [],
                  ),
                  analysis: args.includeProject
                    ? {
                        mode: 'project',
                        analyzedFiles: projectAnalysis?.analyzedFiles ?? 0,
                        limitations: projectAnalysis?.limitations ?? [],
                      }
                    : { mode: 'file' },
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return actionableMcpError(error);
      }
    },
  );

  server.registerTool(
    'record_taint',
    {
      title: 'Record Taint',
      description:
        'Analyze a TypeScript or JavaScript file and record detected taint flows to the knowledge graph.',
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
        const { readFile } = await import('node:fs/promises');

        // K5: validate existence and the single .pmignore boundary before reading.
        const absPath = assertProjectPath(args.filePath, deps.projectRoot, {
          mustExist: true,
          rejectIgnored: true,
        });
        const content = await readFile(absPath, 'utf-8');
        const lang = detectLanguageFromPath(absPath);
        if (!lang) {
          return unsupportedLanguageError('Taint analysis');
        }
        const recorded = analyzer.recordFlows(absPath, content, lang);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  filePath: args.filePath,
                  recorded,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return actionableMcpError(error);
      }
    },
  );
}
