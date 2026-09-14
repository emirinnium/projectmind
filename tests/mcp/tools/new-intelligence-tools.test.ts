import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createIsolatedDatabase } from '../../test-helpers/database.js';
import { registerSearchFeedbackTool } from '../../../src/mcp/tools/search-feedback.js';
import { registerSessionIntelligenceTools } from '../../../src/mcp/tools/session-intelligence.js';
import { registerBugSurfaceTool } from '../../../src/mcp/tools/bug-surface.js';
import { registerAskCodebaseTool } from '../../../src/mcp/tools/ask.js';
import { stableHash } from '../../../src/utils/hash.js';
import type { McpDependencies } from '../../../src/mcp/tools/types.js';

interface RegisteredTool {
  handler: (args: unknown) => Promise<{ content: Array<{ text?: string }> }>;
}

function toolsOf(server: McpServer): Record<string, RegisteredTool> {
  return (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
}

function payload(response: { content: Array<{ text?: string }> }): Record<string, unknown> {
  return JSON.parse(response.content[0]?.text ?? '{}') as Record<string, unknown>;
}

describe('new intelligence MCP interfaces', () => {
  it('records search feedback through the registered handler', async () => {
    const isolated = createIsolatedDatabase();
    try {
      const server = new McpServer({ name: 'search-feedback-test', version: '1.0.0' });
      registerSearchFeedbackTool(server, {
        db: isolated.db,
        kg: { getCurrentProjectId: () => 1 },
        projectRoot: process.cwd(),
      } as unknown as McpDependencies);
      const result = payload(
        await toolsOf(server).record_search_feedback.handler({
          query: 'find auth',
          resultPath: 'src/auth.ts',
          position: 1,
          feedback: 'selected',
          features: {
            lexical: 1,
            vector: 0.5,
            graph: 0.5,
            history: 0.5,
            freshness: 1,
            fileType: 1,
            pathDepth: 0.5,
            canonical: 0.5,
          },
        }),
      );
      expect(result).toMatchObject({ success: true, privacy: { queryStored: false } });
      expect(
        isolated.db.prepare('SELECT COUNT(*) AS count FROM search_interactions').get(),
      ).toEqual({
        count: 1,
      });
    } finally {
      isolated.cleanup();
    }
  });

  it('records and reads session events through the registered handlers', async () => {
    const isolated = createIsolatedDatabase();
    try {
      const session = isolated.db
        .prepare(
          `INSERT INTO agent_sessions (agent_name, project_id, context_hash, decisions, fingerprint)
         VALUES ('agent-a', 1, '', '[]', '{}')`,
        )
        .run();
      const server = new McpServer({ name: 'session-intelligence-test', version: '1.0.0' });
      registerSessionIntelligenceTools(server, {
        db: isolated.db,
        kg: { getCurrentProjectId: () => 1 },
        projectRoot: process.cwd(),
      } as unknown as McpDependencies);
      const registered = toolsOf(server);
      const event = payload(
        await registered.record_session_event.handler({
          sessionId: Number(session.lastInsertRowid),
          agentName: 'agent-a',
          eventType: 'file_touched',
          eventKey: 'src/auth.ts',
        }),
      );
      expect(event).toMatchObject({ success: true, receipt: { eventType: 'file_touched' } });
      const insights = payload(await registered.get_session_insights.handler({}));
      expect(insights).toMatchObject({ success: true, insights: { eventsScanned: 1 } });
    } finally {
      isolated.cleanup();
    }
  });

  it('returns a bounded predictive bug-surface report', async () => {
    const isolated = createIsolatedDatabase();
    const root = await mkdtemp(join(tmpdir(), 'projectmind-mcp-bug-'));
    try {
      await mkdir(join(root, 'src'));
      const sourcePath = join(root, 'src', 'hot.ts');
      await writeFile(sourcePath, 'export const hot = true;\n', 'utf8');
      isolated.db
        .prepare('INSERT INTO projects (id, name, root_path) VALUES (1, ?, ?)')
        .run('mcp-bug-test', root);
      isolated.db
        .prepare(
          `INSERT INTO files (id, project_id, path, relative_path, language, size_bytes, hash)
         VALUES (1, 1, ?, 'src/hot.ts', 'typescript', 24, 'hash')`,
        )
        .run(sourcePath);
      const server = new McpServer({ name: 'bug-surface-test', version: '1.0.0' });
      registerBugSurfaceTool(server, {
        db: isolated.db,
        projectRoot: root,
        kg: {
          getCurrentProjectId: () => 1,
          getAllFiles: () => [
            {
              id: 1,
              path: sourcePath,
              relativePath: 'src/hot.ts',
              language: 'typescript',
              sizeBytes: 24,
              hash: 'hash',
              agentTouched: false,
              agentTouchedBy: null,
              agentTouchedAt: null,
              cognitiveLoad: 0,
              lastScanned: '',
              lastSynced: '',
              patterns: [],
            },
          ],
          getDependents: () => [],
          getFunctions: () => [],
        },
      } as unknown as McpDependencies);
      const result = payload(await toolsOf(server).predict_bug_surface.handler({ limit: 1 }));
      expect(result).toMatchObject({
        success: true,
        report: { mode: 'predictive', filesReported: 1 },
      });
    } finally {
      isolated.cleanup();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('answers a codebase question with fresh evidence through MCP', async () => {
    const root = await mkdtemp(join(tmpdir(), 'projectmind-mcp-ask-'));
    try {
      await mkdir(join(root, 'src'));
      const sourcePath = join(root, 'src', 'auth.ts');
      const source = 'export function authenticate(token: string) { return token.length > 0; }\n';
      await writeFile(sourcePath, source, 'utf8');
      const info = {
        id: 1,
        path: sourcePath,
        relativePath: 'src/auth.ts',
        language: 'typescript',
        sizeBytes: Buffer.byteLength(source),
        hash: stableHash(source),
        agentTouched: false,
        agentTouchedBy: null,
        agentTouchedAt: null,
        cognitiveLoad: 0,
        lastScanned: new Date().toISOString(),
        lastSynced: new Date().toISOString(),
        patterns: [],
      };
      const server = new McpServer({ name: 'ask-test', version: '1.0.0' });
      registerAskCodebaseTool(server, {
        projectRoot: root,
        kg: {
          getAllFiles: () => [info],
          getFileByPath: (path: string) =>
            path === sourcePath || path === 'src/auth.ts' ? info : null,
        },
      } as unknown as McpDependencies);
      const result = payload(
        await toolsOf(server).ask_codebase.handler({
          question: 'Where is authenticate defined?',
          limit: 1,
          maxFilesToInspect: 1,
          useLlm: false,
        }),
      );
      expect(result).toMatchObject({
        success: true,
        questionType: 'where',
        evidence: [{ filePath: 'src/auth.ts', freshness: 'fresh' }],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
