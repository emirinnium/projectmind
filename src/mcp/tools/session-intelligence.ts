import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from './types.js';
import {
  getSessionInsights,
  recordSessionEvent,
  type SessionEventType,
} from '@/core/intelligence/session-learner.js';
import { actionableMcpError } from '@/utils/actionable-error.js';

function json(value: object): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

/** Register explicit cross-session learning operations. */
export function registerSessionIntelligenceTools(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'record_session_event',
    {
      title: 'Record Session Event',
      description:
        'Record a bounded, payload-free session event for future project insights. Use file_touched, tool_used, pattern, or outcome; never send source text, prompts, secrets, or personal data as event values.',
      inputSchema: {
        sessionId: z.number().int().positive().describe('Existing agent session ID'),
        agentName: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .describe('Agent identity used to start the session'),
        eventType: z
          .enum(['file_touched', 'tool_used', 'pattern', 'outcome'])
          .describe('Type of explicit event'),
        eventKey: z.string().trim().min(1).max(500).describe('Relative path or bounded identifier'),
        eventValue: z.string().max(500).optional().describe('Optional bounded scalar value'),
        success: z.boolean().optional().describe('Outcome success when eventType=outcome'),
        metadata: z
          .record(
            z.string().max(100),
            z.union([z.string().max(500), z.number().finite(), z.boolean()]),
          )
          .optional()
          .describe('Optional non-source metadata'),
      },
    },
    async (args) => {
      try {
        if (!deps.db) throw new Error('Session intelligence requires an initialized database.');
        const receipt = recordSessionEvent(deps.db, deps.kg.getCurrentProjectId(), {
          sessionId: args.sessionId,
          agentName: args.agentName,
          eventType: args.eventType as SessionEventType,
          eventKey: args.eventKey,
          eventValue: args.eventValue,
          success: args.success,
          metadata: args.metadata,
        });
        return json({ success: true, receipt });
      } catch (error) {
        return actionableMcpError(error);
      }
    },
  );

  server.registerTool(
    'get_session_insights',
    {
      title: 'Get Session Insights',
      description:
        'Aggregate explicit session events into recurring files, tool usage, outcomes, and actionable suggestions. Results are evidence counts, not inferred claims about unrecorded activity.',
      inputSchema: {
        agentName: z.string().trim().min(1).max(200).optional().describe('Optional agent filter'),
        limit: z.number().int().min(1).max(100).default(10).describe('Rows per insight group'),
        maxEvents: z.number().int().min(1).max(100000).default(10000).describe('Event scan cap'),
      },
    },
    async (args) => {
      try {
        if (!deps.db) throw new Error('Session intelligence requires an initialized database.');
        return json({
          success: true,
          insights: getSessionInsights(deps.db, deps.kg.getCurrentProjectId(), {
            agentName: args.agentName,
            limit: args.limit,
            maxEvents: args.maxEvents,
          }),
        });
      } catch (error) {
        return actionableMcpError(error);
      }
    },
  );
}
