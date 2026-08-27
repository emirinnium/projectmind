import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from '../types.js';
import { ClaudeCodeClient } from './claude-code-client.js';

const claudeCodeClient = new ClaudeCodeClient({
  apiKey: process.env.CLAUDE_CODE_API_KEY,
  model: process.env.CLAUDE_CODE_MODEL || 'claude-3-opus-20240229',
});

/**
 * Register Claude Code tools for code analysis and generation.
 */
export function registerClaudeCodeTools(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'claude_code_analyze',
    {
      title: 'Claude Code Analyze',
      description: 'Analyze code using Claude Code',
      inputSchema: {
        filePath: z.string().describe('Path of the file to analyze'),
        prompt: z.string().describe('Prompt for Claude Code'),
      },
    },
    async ({ filePath, prompt }: { filePath: string; prompt: string }) => {
      try {
        const { readFileSync } = await import('node:fs');
        const content = readFileSync(filePath, 'utf-8');
        const response = await claudeCodeClient.analyzeCode(content, prompt);
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
    'claude_code_generate',
    {
      title: 'Claude Code Generate',
      description: 'Generate code using Claude Code',
      inputSchema: {
        prompt: z.string().describe('Prompt for Claude Code'),
        context: z.string().optional().describe('Context for code generation'),
      },
    },
    async ({ prompt, context }: { prompt: string; context?: string }) => {
      try {
        const response = await claudeCodeClient.generateCode(prompt, context);
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
