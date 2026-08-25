import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from './tools/types.js';
import { getStatement } from '../storage/database.js';
import { loadConfig } from '../utils/config.js';
import { logger } from '../cli/utils/logger.js';

/**
 * MCP Resources & Prompts.
 *
 * Resources expose contextual data (DB schema, sanitized config, project
 * stats) via the standard resources/read flow — cacheable by clients instead
 * of ad-hoc tool calls. Prompts expose reusable agent workflows.
 */

const MASK_KEYS = /apikey|api_key|token|secret|password/i;

function maskSecrets(obj: unknown, depth = 0): unknown {
  if (depth > 6) return '[deep]';
  if (Array.isArray(obj)) return obj.map((v) => maskSecrets(v, depth + 1));
  if (obj && typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[k] = MASK_KEYS.test(k) ? '***masked***' : maskSecrets(v, depth + 1);
    }
    return out;
  }
  return obj;
}

export function registerCoreResources(server: McpServer, deps: McpDependencies): void {
  // pm://schema — live table list from the knowledge-graph database.
  server.registerResource(
    'schema',
    'pm://schema',
    { title: 'Database Schema', description: 'Table names of the ProjectMind knowledge-graph SQLite database.', mimeType: 'application/json' },
    async () => {
      let tables: unknown = [];
      try {
        tables = getStatement(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all();
      } catch (e) {
        logger.warn('pm://schema read failed', { error: e });
      }
      return { contents: [{ uri: 'pm://schema', mimeType: 'application/json', text: JSON.stringify({ tables }, null, 2) }] };
    }
  );

  // pm://config — sanitized effective configuration (secrets masked).
  server.registerResource(
    'config',
    'pm://config',
    { title: 'Effective Config', description: 'Resolved ProjectMind configuration with all secrets masked.', mimeType: 'application/json' },
    async () => {
      let config: unknown;
      try {
        config = maskSecrets(loadConfig());
      } catch (e) {
        config = { error: String(e) };
      }
      return { contents: [{ uri: 'pm://config', mimeType: 'application/json', text: JSON.stringify(config, null, 2) }] };
    }
  );

  // pm://stats — quick project statistics from the knowledge graph.
  server.registerResource(
    'stats',
    'pm://stats',
    { title: 'Project Stats', description: 'File counts per language, agent-touch coverage and session count for the active project.', mimeType: 'application/json' },
    async () => {
      const stats: Record<string, unknown> = {};
      try {
        const files = deps.kg.getAllFiles();
        const languages: Record<string, number> = {};
        let touched = 0;
        for (const f of files) {
          const lang = f.language || 'unknown';
          languages[lang] = (languages[lang] ?? 0) + 1;
          if (f.agentTouched) touched++;
        }
        stats.totalFiles = files.length;
        stats.languages = languages;
        stats.agentTouchedFiles = touched;
        stats.agentCoverage = files.length > 0 ? Math.round((touched / files.length) * 1000) / 10 + '%' : '0%';
      } catch (e) {
        stats.error = String(e);
      }
      return { contents: [{ uri: 'pm://stats', mimeType: 'application/json', text: JSON.stringify(stats, null, 2) }] };
    }
  );
}

type PromptArgs = Record<string, string | undefined>;

export function registerWorkflowPrompts(server: McpServer): void {
  server.registerPrompt(
    'impact-first-refactor',
    {
      title: 'Impact-First Refactor',
      description: 'Refactor a file the safe way: context → impact → change → coherence.',
      argsSchema: { file: z.string().describe('Relative path of the file to refactor') },
    },
    ({ file }: PromptArgs) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: [
            `I want to refactor \`${file ?? '<file>'}\` safely.`,
            '',
            'Follow this workflow with the ProjectMind tools before touching code:',
            '1. get_context on the file — understand imports, dependents and similar files.',
            '2. analyze_impact on it — list everything that breaks if signatures change.',
            '3. Only then propose the refactor; keep public surfaces stable where impact is high.',
            '4. After editing, run check_coherence on the modified file and fix any warn/fail verdicts.',
          ].join('\n'),
        },
      }],
    })
  );

  server.registerPrompt(
    'pre-commit-checklist',
    {
      title: 'Pre-Commit Checklist',
      description: 'Full quality gate before committing: coherence, debt, circular deps, genome.',
    },
    () => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: [
            'Run the ProjectMind pre-commit quality gate:',
            '1. debt_report — high-severity items must be 0.',
            '2. find_circular_deps — no new cycles introduced.',
            '3. genome_score — confirm score stays ≥ 70%.',
            '4. run_cli ["doctor","scan-health"] — full health sweep.',
            'Report each gate as PASS/FAIL with numbers before I commit.',
          ].join('\n'),
        },
      }],
    })
  );

  server.registerPrompt(
    'debt-triage',
    {
      title: 'Debt Triage',
      description: 'Triage cognitive-debt findings into fix-now / schedule / accept buckets.',
    },
    () => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: [
            'Triage my technical debt:',
            '1. Call debt_report, then debt-prioritize via run_cli for severity ordering.',
            '2. Group findings into: FIX-NOW (high severity, small effort), SCHEDULE (systemic), ACCEPT (informational).',
            '3. For each FIX-NOW item propose the minimal change.',
          ].join('\n'),
        },
      }],
    })
  );

  server.registerPrompt(
    'explain-file-context',
    {
      title: 'Explain File Context',
      description: 'Onboard-style explanation of what a file does and why it matters.',
      argsSchema: { file: z.string().describe('Relative path of the file to explain') },
    },
    ({ file }: PromptArgs) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: [
            `Explain \`${file ?? '<file>'}\` to a new teammate:`,
            '1. get_context on it — summarize purpose from imports/dependents/similar files.',
            '2. analyze_impact — how central is it? What breaks without it?',
            '3. Give a 5-line summary: role, key exports, main collaborators, risk notes.',
          ].join('\n'),
        },
      }],
    })
  );
}
