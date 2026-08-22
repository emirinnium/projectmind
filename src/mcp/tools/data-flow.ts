import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from './types.js';
import { trackAgentAccess } from './types.js';

export function registerDataFlowTools(server: McpServer, deps: McpDependencies): void {
  // Record a data-flow edge
  server.registerTool(
    'record_data_flow',
    {
      title: 'Record Data Flow',
      description: 'Record a data-flow edge between resources or functions for taint tracking. Use this when source code analysis identifies how data moves between sinks and sources.',
      inputSchema: {
        fromQualifiedName: z.string().describe('Qualified name of the source resource (e.g. fs.readFile("./input.txt"))'),
        fromKind: z.enum(['FILE', 'NETWORK', 'DATABASE', 'ENV', 'STDIN', 'STDOUT', 'STDERR', 'SOCKET']).describe('Kind of the source resource'),
        fromIdentity: z.string().describe('Identity string of the source resource (file path, URL, env var name, etc.)'),
        toQualifiedName: z.string().describe('Qualified name of the target resource or function'),
        toKind: z.enum(['FILE', 'NETWORK', 'DATABASE', 'ENV', 'STDIN', 'STDOUT', 'STDERR', 'SOCKET']).describe('Kind of the target resource'),
        toIdentity: z.string().describe('Identity string of the target resource'),
        kind: z.enum(['resource', 'arg', 'return']).describe('How the data flows: direct resource, function argument, or return value'),
        via: z.string().optional().describe('Optional intermediate (function name, variable, etc.)'),
        sourceFunctionName: z.string().optional().describe('Optional name of the source function'),
        targetFunctionName: z.string().optional().describe('Optional name of the target function'),
      },
    },
    async (args) => {
      try {
        if (deps.agentName) {
          trackAgentAccess(deps.kg, deps.agentName, 'data-flow-record');
        }

        const result = deps.kg.recordDataFlow({
          fromResourceQualifiedName: args.fromQualifiedName,
          fromResourceKind: args.fromKind,
          fromResourceIdentity: args.fromIdentity,
          toResourceQualifiedName: args.toQualifiedName,
          toResourceKind: args.toKind,
          toResourceIdentity: args.toIdentity,
          kind: args.kind,
          via: args.via,
          sourceFunctionName: args.sourceFunctionName,
          targetFunctionName: args.targetFunctionName,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                id: result.id,
                fromResource: result.fromResource,
                toResource: result.toResource,
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

  // Get all data flows for the current project
  server.registerTool(
    'get_data_flows',
    {
      title: 'Get Data Flows',
      description: 'Get all recorded data flows for the current project. Shows how resources and functions are connected via taint edges.',
      inputSchema: {},
    },
    async () => {
      try {
        if (deps.agentName) {
          trackAgentAccess(deps.kg, deps.agentName, 'data-flow-get');
        }

        const flows = deps.kg.getDataFlows();

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                count: flows.length,
                flows,
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

  // Get data flows for a specific resource
  server.registerTool(
    'get_resource_flows',
    {
      title: 'Get Resource Flows',
      description: 'Get all data flows (incoming and outgoing) for a specific resource. Useful for understanding how a file, network endpoint, or env var participates in data flow.',
      inputSchema: {
        qualifiedName: z.string().describe('Qualified name of the resource to analyze'),
      },
    },
    async (args) => {
      try {
        if (deps.agentName) {
          trackAgentAccess(deps.kg, deps.agentName, 'data-flow-resource');
        }

        const flows = deps.kg.getResourceFlows(args.qualifiedName);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                qualifiedName: args.qualifiedName,
                count: flows.length,
                flows,
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

  // Clear data flows
  server.registerTool(
    'clear_data_flows',
    {
      title: 'Clear Data Flows',
      description: 'Clear all recorded data flows for the current project.',
      inputSchema: {},
    },
    async () => {
      try {
        if (deps.agentName) {
          trackAgentAccess(deps.kg, deps.agentName, 'data-flow-clear');
        }

        const cleared = deps.kg.clearDataFlows();

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                cleared,
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
