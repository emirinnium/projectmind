import { describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { annotateToolRegistration } from '../../../src/mcp/tools/guard.js';
import { registerEvidenceLedgerTool } from '../../../src/mcp/tools/evidence-ledger.js';
import { EvidenceLedger } from '../../../src/core/ledger/evidence-ledger.js';
import { createTestKnowledgeGraph } from '../../test-helpers/knowledge-graph.js';
import type { McpDependencies } from '../../../src/mcp/tools/types.js';

describe('evidence_ledger MCP tool', () => {
  it('lists and verifies the active project chain without returning payloads', async () => {
    const testGraph = createTestKnowledgeGraph();
    try {
      const ledger = new EvidenceLedger(testGraph.db, 1);
      ledger.append({
        eventType: 'context',
        toolName: 'get_context',
        input: { secret: 'hidden' },
        result: { content: 'source' },
      });
      const server = new McpServer({ name: 'ledger-test', version: '1.0.0' });
      annotateToolRegistration(server);
      registerEvidenceLedgerTool(server, {
        kg: testGraph.kg,
        db: testGraph.db,
      } as McpDependencies);
      const registered = (
        server as unknown as {
          _registeredTools: Record<string, { handler: (args: unknown) => Promise<unknown> }>;
        }
      )._registeredTools.evidence_ledger;
      const response = (await registered.handler({ operation: 'list', limit: 10 })) as {
        content: Array<{ text: string }>;
      };
      const payload = JSON.parse(response.content[0]!.text) as {
        success: boolean;
        records: Array<{ inputHash: string }>;
        verification: { valid: boolean };
      };
      expect(payload.success).toBe(true);
      expect(payload.verification.valid).toBe(true);
      expect(payload.records).toHaveLength(1);
      expect(payload.records[0]?.inputHash).not.toContain('hidden');

      const exported = (await registered.handler({ operation: 'export', limit: 10 })) as {
        content: Array<{ text: string }>;
      };
      const exportedPayload = JSON.parse(exported.content[0]!.text) as {
        export: { format: string; records: Array<{ inputHash: string }> };
      };
      expect(exportedPayload.export.format).toBe('projectmind-evidence-ledger-v1');
      expect(exportedPayload.export.records[0]?.inputHash).not.toContain('hidden');

      const recordTool = (
        server as unknown as {
          _registeredTools: Record<string, { handler: (args: unknown) => Promise<unknown> }>;
        }
      )._registeredTools.record_evidence;
      const recorded = (await recordTool.handler({
        eventType: 'custom',
        toolName: 'test-decision',
        input: { source: 'agent' },
        result: { accepted: false },
        summary: { accepted: false },
      })) as { content: Array<{ text: string }> };
      const recordedPayload = JSON.parse(recorded.content[0]!.text) as {
        success: boolean;
        record: { id: number };
      };
      expect(recordedPayload).toMatchObject({ success: true, record: { id: 2 } });
    } finally {
      testGraph.cleanup();
    }
  });
});
