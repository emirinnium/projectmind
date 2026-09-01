import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from './types.js';
import { trackAgentAccess } from './types.js';

export function registerProjectTools(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'list_projects',
    {
      title: 'List Projects',
      description: 'List all projects in the knowledge graph with file counts and last scan time.',
      inputSchema: {},
    },
    async () => {
      try {
        if (deps.agentName) {
          trackAgentAccess(deps.kg, deps.agentName, 'list-projects');
        }
        const projects = deps.kg.listProjects();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  projects,
                  total: projects.length,
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

  server.registerTool(
    'create_project',
    {
      title: 'Create Project',
      description: 'Create a new project in the knowledge graph.',
      inputSchema: {
        name: z.string().describe('Project name'),
        rootPath: z.string().describe('Root path of the project'),
        description: z.string().optional().describe('Optional description'),
      },
    },
    async (args) => {
      try {
        if (deps.agentName) {
          trackAgentAccess(deps.kg, deps.agentName, 'create-project');
        }
        const project = deps.kg.createProject(args.name, args.rootPath, args.description);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  project,
                  message: `Project '${project.name}' created with ID ${project.id}`,
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

  server.registerTool(
    'switch_project',
    {
      title: 'Switch Project',
      description: 'Switch the current project context for subsequent operations.',
      inputSchema: {
        projectId: z.number().describe('Project ID to switch to'),
      },
    },
    async (args) => {
      try {
        if (deps.agentName) {
          trackAgentAccess(deps.kg, deps.agentName, 'switch-project');
        }
        const result = deps.kg.switchProject(args.projectId);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: result.success,
                  project: result.project,
                  error: result.error,
                  message: result.success
                    ? `Switched to project '${result.project!.name}'`
                    : result.error,
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
