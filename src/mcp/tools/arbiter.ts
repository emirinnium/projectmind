import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { EvidenceLedger } from '@/core/ledger/evidence-ledger.js';
import {
  arbitrateAgents,
  type ArbitrateAgentsInput,
  type ArbiterAgentPlan,
} from '@/core/coordination/arbiter.js';
import { actionableMcpError } from '@/utils/actionable-error.js';
import type { McpDependencies } from './types.js';

const mergeContentChangeSchema = z.object({
  filePath: z.string().trim().min(1).max(1000),
  baseContent: z.string().max(200_000),
  proposedContent: z.string().max(200_000),
});

const arbiterAgentSchema = z.object({
  agentName: z.string().trim().min(1).max(200),
  files: z.array(z.string().trim().min(1).max(1000)).min(1).max(100),
  priority: z.number().int().min(-100).max(100).default(0),
  contentChanges: z.array(mergeContentChangeSchema).max(100).optional(),
});

const arbiterInputSchema = {
  agents: z
    .array(arbiterAgentSchema)
    .min(2)
    .max(32)
    .superRefine((agents, context) => {
      const names = new Set<string>();
      agents.forEach((agent, index) => {
        if (names.has(agent.agentName)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index, 'agentName'],
            message: `Duplicate agentName: ${agent.agentName}`,
          });
        }
        names.add(agent.agentName);
      });
    })
    .describe('At least two planned agents, each with the files it intends to edit.'),
  recordEvidence: z
    .boolean()
    .default(true)
    .describe('Append a payload-free hash-chain collision record when a database is available.'),
};

function json(result: object): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

export function registerArbitrateAgentsTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'arbitrate_agents',
    {
      title: 'Arbitrate Multi-Agent Work',
      description:
        'Coordinate multiple agents before parallel edits. Combines advisory file locks, bidirectional blast-radius/dependency risk, bounded three-way content evidence, deterministic conflict groups, file-sharding suggestions, and a dependency-aware rebase order. The tool never writes source files or git state. By default it appends only hashes and bounded summary metadata to the local Evidence Ledger; set recordEvidence=false for a read-only run.',
      inputSchema: arbiterInputSchema,
    },
    async (args) => {
      try {
        const input: ArbitrateAgentsInput = {
          agents: args.agents.map((agent): ArbiterAgentPlan => ({
            agentName: agent.agentName,
            files: agent.files,
            priority: agent.priority,
            contentChanges: agent.contentChanges,
          })),
        };
        const report = arbitrateAgents(deps.kg, input);
        const recordEvidence = args.recordEvidence ?? true;
        let ledger: object;
        if (!recordEvidence) {
          ledger = {
            recorded: false,
            reason: 'Evidence recording was disabled for this invocation.',
          };
        } else if (!deps.db) {
          ledger = {
            recorded: false,
            reason:
              'No initialized database was available; the arbitration report was not persisted.',
          };
        } else {
          const record = new EvidenceLedger(deps.db, deps.kg.getCurrentProjectId()).append({
            eventType: 'custom',
            toolName: 'arbitrate_agents',
            input,
            result: report,
            scope: `project:${deps.kg.getCurrentProjectId()}`,
            sourceFreshness: 'not-checked',
            summary: {
              agentCount: report.agents.length,
              pairCount: report.pairRisks.length,
              conflictGroupCount: report.conflictGroups.length,
              highRiskAgentCount: report.agentRisks.filter((risk) => risk.level === 'high').length,
            },
          });
          ledger = {
            recorded: true,
            recordId: record.id,
            recordHash: record.recordHash,
            note: 'Only input/result hashes and bounded summary metadata were persisted.',
          };
        }
        return json({ success: true, report, ledger });
      } catch (error) {
        return actionableMcpError(error);
      }
    },
  );
}
