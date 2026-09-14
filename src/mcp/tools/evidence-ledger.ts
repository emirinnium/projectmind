import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from './types.js';
import { EvidenceLedger } from '@/core/ledger/evidence-ledger.js';
import { ledgerEventSchema } from '@/core/ledger/evidence-ledger.js';
import { actionableMcpError } from '@/utils/actionable-error.js';

export function registerEvidenceLedgerTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'evidence_ledger',
    {
      title: 'Verify Evidence Ledger',
      description:
        'List or verify the append-only hash chain of ProjectMind tool decisions. Payload contents are never returned from the ledger; verification reports chain and tamper failures with record IDs.',
      inputSchema: {
        operation: z.enum(['list', 'verify', 'export']).default('verify'),
        afterId: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(1000).default(100),
      },
    },
    async (args) => {
      if (!deps.db) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: false,
                error: 'Evidence ledger requires an initialized database.',
                nextAction: 'Start ProjectMind with its normal MCP/CLI database initialization.',
              }),
            },
          ],
        };
      }
      const ledger = new EvidenceLedger(deps.db, deps.kg.getCurrentProjectId());
      const verification = ledger.verify();
      const payload =
        args.operation === 'list'
          ? {
              success: true,
              operation: 'list',
              verification,
              records: ledger.list({ afterId: args.afterId, limit: args.limit }),
              nextAction: 'Run operation=verify before relying on the recorded chain.',
            }
          : args.operation === 'export'
            ? {
                success: true,
                operation: 'export',
                export: ledger.exportRecords(args.limit),
                nextAction:
                  'Save this payload and run pm ledger verify --export <file> independently.',
              }
            : {
                success: verification.valid,
                operation: 'verify',
                verification,
                nextAction: verification.valid
                  ? 'The checked ledger chain is internally consistent.'
                  : 'Stop relying on affected records, preserve the database, and investigate the listed record IDs.',
              };
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
    },
  );

  server.registerTool(
    'record_evidence',
    {
      title: 'Record Evidence Decision',
      description:
        'Explicitly append a payload-free, hash-chained evidence record for a context, review, edit, scan, or custom decision. Input and result payloads are hashed and never stored verbatim.',
      inputSchema: {
        eventType: z.enum(['mcp-invocation', 'scan', 'context', 'review', 'edit', 'custom']),
        toolName: z.string().trim().min(1).max(200),
        input: z.unknown(),
        result: z.unknown(),
        graphHash: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .nullable()
          .optional(),
        policyVersion: z.string().trim().min(1).max(100).nullable().optional(),
        scope: z.string().trim().min(1).max(500).nullable().optional(),
        sourceFreshness: z
          .enum(['fresh', 'stale', 'unindexed', 'missing', 'unknown', 'not-checked'])
          .nullable()
          .optional(),
        summary: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
          .optional(),
      },
    },
    async (args) => {
      try {
        if (!deps.db) throw new Error('Evidence ledger requires an initialized database.');
        const event = ledgerEventSchema.parse(args);
        const record = new EvidenceLedger(deps.db, deps.kg.getCurrentProjectId()).append(event);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  record,
                  note: 'Only hashes and bounded summary metadata were persisted.',
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
