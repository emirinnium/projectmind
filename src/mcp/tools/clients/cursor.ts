import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from '../types.js';
import { CursorClient } from './cursor-client.js';

const cursorClient = new CursorClient({
  apiKey: process.env.CURSOR_API_KEY,
  model: process.env.CURSOR_MODEL || 'cursor-2',
});

/**
 * Register Cursor tools for code analysis and generation.
 */
export function registerCursorTools(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'cursor_analyze',
    {
      title: 'Cursor Analyze',
      description: 'Analyze code using Cursor',
      inputSchema: {
        filePath: z.string().describe('Path of the file to analyze'),
        prompt: z.string().describe('Prompt for Cursor'),
      },
    },
    async ({ filePath, prompt }: { filePath: string; prompt: string }) => {
      try {
        const { readFileSync } = await import('node:fs');
        const content = readFileSync(filePath, 'utf-8');
        const response = await cursorClient.analyzeCode(content, prompt);
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
    'cursor_generate',
    {
      title: 'Cursor Generate',
      description: 'Generate code using Cursor',
      inputSchema: {
        prompt: z.string().describe('Prompt for Cursor'),
        context: z.string().optional().describe('Context for code generation'),
      },
    },
    async ({ prompt, context }: { prompt: string; context?: string }) => {
      try {
        const response = await cursorClient.generateCode(prompt, context);
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
