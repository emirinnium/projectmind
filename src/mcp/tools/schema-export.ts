import { toJSONSchema } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export interface ExportedMcpToolSchema {
  name: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>;
}

interface RegisteredTool {
  inputSchema?: unknown;
  annotations?: Record<string, unknown>;
}

interface IntrospectableServer {
  _registeredTools: Record<string, RegisteredTool>;
}

/**
 * Export the actual registered Zod schemas as JSON Schema.
 *
 * This intentionally introspects the SDK registration table rather than a
 * second hand-written catalog, so tools/list and generated documentation use
 * the same runtime contract.
 */
export function exportRegisteredToolSchemas(server: McpServer): ExportedMcpToolSchema[] {
  const registered = (server as unknown as IntrospectableServer)._registeredTools;
  return Object.entries(registered)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, tool]) => {
      if (!tool.inputSchema || !tool.annotations) {
        throw new Error(`MCP tool ${name} is missing schema or annotations.`);
      }
      return {
        name,
        inputSchema: toJSONSchema(tool.inputSchema as never) as Record<string, unknown>,
        annotations: { ...tool.annotations },
      };
    });
}
