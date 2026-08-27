import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from '../types.js';
import { OpenCodeClient } from './opencode-client.js';

const openCodeClient = new OpenCodeClient({
  apiKey: process.env.OPENCODE_API_KEY,
  model: process.env.OPENCODE_MODEL || 'opencode-3',
});

/**
 * Register OpenCode tools for code analysis and generation.
 */
export function registerOpenCodeTools(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'opencode_analyze',
    {
      title: 'OpenCode Analyze',
      description: 'Analyze code using OpenCode',
      inputSchema: {
        filePath: z.string().describe('Path of the file to analyze'),
        prompt: z.string().describe('Prompt for OpenCode'),
      },
    },
    async ({ filePath, prompt }: { filePath: string; prompt: string }) => {
      try {
        const { readFileSync } = await import('node:fs');
        const content = readFileSync(filePath, 'utf-8');
        const response = await openCodeClient.analyzeCode(content, prompt);
        return {
          content: [{ type: 'text' as const, text: response }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: `Error analyzing code: ${error instanceof Error ? error.message : String(error)}`,
          }],
        };
      }
    }
  );

  server.registerTool(
    'opencode_generate',
    {
      title: 'OpenCode Generate',
      description: 'Generate code using OpenCode',
      inputSchema: {
        prompt: z.string().describe('Prompt for OpenCode'),
        context: z.string().optional().describe('Context for code generation'),
      },
    },
    async ({ prompt, context }: { prompt: string; context?: string }) => {
      try {
        const response = await openCodeClient.generateCode(prompt, context);
        return {
          content: [{ type: 'text' as const, text: response }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: `Error generating code: ${error instanceof Error ? error.message : String(error)}`,
          }],
        };
      }
    }
  );
}
