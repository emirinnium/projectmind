import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CoherenceEngine } from '../../../src/core/coherence/engine.js';
import { DebtTracker } from '../../../src/core/debt/tracker.js';
import { ScaleManager } from '../../../src/core/scale/manager.js';
import { createTestKnowledgeGraph } from '../../test-helpers/knowledge-graph.js';
import { annotateToolRegistration } from '../../../src/mcp/tools/guard.js';
import { createMcpProjectScopeRuntime } from '../../../src/mcp/tools/project-scope.js';
import { registerProjectTools } from '../../../src/mcp/tools/projects.js';
import type { McpDependencies } from '../../../src/mcp/tools/types.js';

describe('MCP request-local project scope', () => {
  const roots: string[] = [];
  let cleanupGraph: (() => void) | undefined;

  afterEach(() => {
    cleanupGraph?.();
    cleanupGraph = undefined;
    for (const root of roots.splice(0)) {
      // Temporary directories are intentionally left to the OS test cleanup;
      // no project data is deleted by this contract test.
      void root;
    }
  });

  it('selects a project per request without changing global selection', async () => {
    const firstRoot = mkdtempSync(join(tmpdir(), 'projectmind-scope-one-'));
    const secondRoot = mkdtempSync(join(tmpdir(), 'projectmind-scope-two-'));
    mkdirSync(join(firstRoot, 'src'));
    mkdirSync(join(secondRoot, 'src'));
    roots.push(firstRoot, secondRoot);

    const { kg, db, cleanup } = createTestKnowledgeGraph();
    cleanupGraph = cleanup;
    const first = kg.createProject('scope-one', firstRoot);
    const second = kg.createProject('scope-two', secondRoot);
    const coherence = new CoherenceEngine(db);
    const base: McpDependencies = {
      kg,
      db,
      coherence,
      debt: new DebtTracker(db, kg, coherence),
      scale: new ScaleManager(db, kg),
      projectRoot: firstRoot,
    };
    const runtime = createMcpProjectScopeRuntime(base);
    const server = new McpServer({ name: 'project-scope-test', version: '1.0.0' });
    annotateToolRegistration(server, runtime);
    server.registerTool(
      'get_context',
      {
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        inputSchema: {},
      },
      async () => ({
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              projectId: runtime.deps.kg.getCurrentProjectId(),
              root: runtime.deps.projectRoot,
            }),
          },
        ],
      }),
    );

    const registered = (
      server as unknown as {
        _registeredTools: Record<
          string,
          { handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }> }
        >;
      }
    )._registeredTools.get_context;
    const scoped = await registered.handler({ projectId: second.id });
    const scopedPayload = JSON.parse(scoped.content[0]!.text) as {
      projectId: number;
      root: string;
    };
    expect(scopedPayload).toEqual({ projectId: second.id, root: secondRoot });
    expect(kg.getCurrentProjectId()).toBe(1);

    const global = await registered.handler({});
    const globalPayload = JSON.parse(global.content[0]!.text) as {
      projectId: number;
      root: string;
    };
    expect(globalPayload.projectId).toBe(1);
    expect(globalPayload.root).toBe(firstRoot);
    expect(first.id).not.toBe(second.id);

    // Scale reporting must use the request-local root as well as the scoped
    // project_id. If it falls back to global config, the second file is
    // visible in the graph but its source cannot be read and line metrics are
    // silently reported as zero.
    const secondFile = join(secondRoot, 'src', 'second.ts');
    writeFileSync(secondFile, 'export const second = true;\nexport const value = 2;');
    db.prepare(
      'INSERT INTO files (project_id, path, relative_path, language, size_bytes, hash) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(second.id, secondFile, 'src/second.ts', 'typescript', 52, 'second-hash');
    const scopedScale = await runtime.run(second.id, async () =>
      runtime.deps.scale.getScaleReport(),
    );
    expect(scopedScale.totalFiles).toBe(1);
    expect(scopedScale.totalLines).toBe(2);

    db.prepare(
      `INSERT INTO scan_profiles
       (project_id, total_files, scanned_files, error_files, duration_ms, files_per_second, memory_used_mb, errors)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(second.id, 1, 1, 0, 10, 100, 1.5, null);
    const scopedProfile = await runtime.run(second.id, async () =>
      runtime.deps.scale.getLastScanProfile(),
    );
    expect(scopedProfile?.totalFiles).toBe(1);

    const firstSession = kg.startAgentSession('first-agent');
    kg.storeMemory(firstSession, 'scope-check', 'project', 'first');
    const secondSession = await runtime.run(second.id, async () => {
      const session = runtime.deps.kg.startAgentSession('second-agent');
      runtime.deps.kg.storeMemory(session, 'scope-check', 'project', 'second');
      return session;
    });
    const scopedSessions = await runtime.run(second.id, async () =>
      runtime.deps.kg.getAgentSessions(),
    );
    expect(scopedSessions.map((session) => session.id)).toEqual([secondSession]);
    const scopedMemory = await runtime.run(second.id, async () =>
      runtime.deps.kg.getMemory('scope-check', 'project'),
    );
    expect(scopedMemory.map((entry) => entry.value)).toEqual(['second']);
    expect(kg.getMemory('scope-check', 'project').map((entry) => entry.value)).toEqual(['first']);

    registerProjectTools(server, runtime.deps);
    const switchProject = (
      server as unknown as {
        _registeredTools: Record<string, { handler: (args: unknown) => Promise<unknown> }>;
      }
    )._registeredTools.switch_project;
    await switchProject.handler({ projectId: second.id });
    expect(kg.getCurrentProjectId()).toBe(second.id);
  });

  it('rejects invalid and unknown project selectors before invoking a tool', async () => {
    const root = mkdtempSync(join(tmpdir(), 'projectmind-scope-invalid-'));
    roots.push(root);
    const { kg, db, cleanup } = createTestKnowledgeGraph();
    cleanupGraph = cleanup;
    kg.createProject('scope-invalid', root);
    const coherence = new CoherenceEngine(db);
    const runtime = createMcpProjectScopeRuntime({
      kg,
      db,
      coherence,
      debt: new DebtTracker(db, kg, coherence),
      scale: new ScaleManager(db, kg),
      projectRoot: root,
    });
    await expect(runtime.run(0, async () => 'never')).rejects.toThrow(/positive integer/);
    await expect(runtime.run(99999, async () => 'never')).rejects.toThrow(/not found/);
  });
});
