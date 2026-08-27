import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SQLOutputValue } from 'node:sqlite';
import type { McpDependencies } from './tools/types.js';
import { getStatement } from '../storage/database.js';
import { loadConfig } from '../utils/config.js';
import { logger } from '../cli/utils/logger.js';
import { watch as fsWatch, type FSWatcher } from 'node:fs';
import { toolCacheHintMeta } from './tools/list.js';

/**
 * Manages resource subscriptions and notifications.
 */
class ResourceSubscriptionManager {
  private subscriptions = new Map<string, Set<string>>(); // resourceId -> Set<clientId>
  private server: McpServer | null = null;
  private watchers: FSWatcher[] = [];
  private lastNotifyAt = 0;
  private static readonly WATCH_THROTTLE_MS = 400;

  setServer(server: McpServer): void {
    this.server = server;
  }

  /**
   * Subscribe a client to a resource.
   */
  subscribe(resourceId: string, clientId: string): void {
    if (!this.subscriptions.has(resourceId)) {
      this.subscriptions.set(resourceId, new Set());
    }
    this.subscriptions.get(resourceId)?.add(clientId);
    logger.info(`Client ${clientId} subscribed to resource ${resourceId}.`);
  }

  /**
   * Unsubscribe a client from a resource.
   */
  unsubscribe(resourceId: string, clientId: string): void {
    this.subscriptions.get(resourceId)?.delete(clientId);
    logger.info(`Client ${clientId} unsubscribed from resource ${resourceId}.`);
  }

  /**
   * Notify all connected clients that a resource has been updated.
   *
   * Emits a standard `notifications/resources/updated` message for `resourceId`.
   * Per MCP this is a broadcast hint (clients cache resources locally and
   * refresh on receipt), so it fires regardless of explicit subscription
   * interest. It is a safe no-op when no transport is connected.
   */
  async notifyResourceUpdated(resourceId: string): Promise<void> {
    if (!this.server || !this.server.isConnected()) return;
    try {
      await this.server.server.sendResourceUpdated({ uri: resourceId });
      logger.info(`Sent resource/updated notification for ${resourceId}.`);
    } catch (e) {
      logger.warn(`Failed to send resource/updated notification for ${resourceId}:`, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  /**
   * Start a filesystem watcher that maps source edits to resource-updated
   * notifications (the "file watch → resource update" chain).
   *
   * Uses `node:fs` (no external dependency). `persistent: false` guarantees the
   * watcher never keeps the process / test runner alive. Notifications are
   * throttled to avoid flooding clients during bulk edits. Best-effort: if
   * recursive watching is unsupported on the platform it logs and skips.
   */
  startFileWatch(rootDir: string): void {
    if (this.watchers.length > 0) return; // already watching
    const ignored = /(?:^|[\\/])(?:node_modules|\.git|dist|coverage)(?:[\\/]|$)/;
    try {
      const watcher = fsWatch(
        rootDir,
        { recursive: true, persistent: false },
        (_event: string, filename: string | Buffer | null) => {
          if (!filename || ignored.test(String(filename))) return;
          const now = Date.now();
          if (now - this.lastNotifyAt < ResourceSubscriptionManager.WATCH_THROTTLE_MS) return;
          this.lastNotifyAt = now;
          // Source edits change file inventory (schema) and project stats.
          void this.notifyResourceUpdated('pm://stats');
          void this.notifyResourceUpdated('pm://schema');
        }
      );
      this.watchers.push(watcher);
      logger.info(`Resource file-watch started for ${rootDir}`);
    } catch (e) {
      logger.warn('Resource file-watch unavailable (recursive watch unsupported on this platform):', {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
}

// Singleton instance
const subscriptionManager = new ResourceSubscriptionManager();

/**
 * MCP Resources & Prompts.
 *
 * Resources expose contextual data (DB schema, sanitized config, project
 * stats) via the standard resources/read flow — cacheable by clients instead
 * of ad-hoc tool calls. Prompts expose reusable agent workflows.
 */

const MASK_KEYS = /apikey|api_key|token|secret|password/i;

type JsonScalar = string | number | boolean | null;
type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };

function maskSecrets(obj: JsonValue, depth = 0): JsonValue {
  if (depth > 6) return '[deep]';
  if (Array.isArray(obj)) return obj.map((v) => maskSecrets(v, depth + 1));
  if (obj && typeof obj === 'object') {
    const out: { [key: string]: JsonValue } = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = MASK_KEYS.test(k) ? '***masked***' : maskSecrets(v, depth + 1);
    }
    return out;
  }
  return obj;
}

export function registerCoreResources(server: McpServer, deps: McpDependencies): void {
  // Set the server for the subscription manager
  subscriptionManager.setServer(server);
  // Real-time chain: source edits → resource/updated notifications.
  subscriptionManager.startFileWatch(process.cwd());

  // pm://schema — live table list from the knowledge-graph database.
  server.registerResource(
    'schema',
    'pm://schema',
    {
      title: 'Database Schema', 
      description: 'Table names of the ProjectMind knowledge-graph SQLite database.', 
      mimeType: 'application/json',
      _meta: { supportsSubscribe: true },
    },
    async () => {
      let tables: Array<Record<string, SQLOutputValue>> = [];
      try {
        tables = getStatement(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all();
      } catch (e) {
        logger.warn('pm://schema read failed', { error: e instanceof Error ? e.message : String(e) });
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
      let config: JsonValue;
      try {
        config = maskSecrets(loadConfig() as unknown as JsonValue);
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
      const stats: { totalFiles: number; languages: Record<string, number>; agentTouchedFiles: number; agentCoverage: string | number; error?: string } = { totalFiles: 0, languages: {}, agentTouchedFiles: 0, agentCoverage: '0%' };
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

/**
 * Register the resource subscription tool.
 */
export function registerResourceSubscriptionTool(server: McpServer): void {
  server.registerTool(
    'resource_subscribe',
    {
      ...toolCacheHintMeta('resource_subscribe'),
      title: 'Resource Subscribe',
      description: 'Subscribe to updates for a specific resource.',
      inputSchema: {
        resourceId: z.string().describe('The ID of the resource to subscribe to.'),
        clientId: z.string().describe('The client ID to associate with this subscription.'),
      },
    },
    async ({ resourceId, clientId }: { resourceId: string; clientId: string }) => {
      subscriptionManager.subscribe(resourceId, clientId);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true }) }] };
    }
  );

  server.registerTool(
    'resource_unsubscribe',
    {
      ...toolCacheHintMeta('resource_unsubscribe'),
      title: 'Resource Unsubscribe',
      description: 'Unsubscribe from updates for a specific resource.',
      inputSchema: {
        resourceId: z.string().describe('The ID of the resource to unsubscribe from.'),
        clientId: z.string().describe('The client ID to remove from this subscription.'),
      },
    },
    async ({ resourceId, clientId }: { resourceId: string; clientId: string }) => {
      subscriptionManager.unsubscribe(resourceId, clientId);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true }) }] };
    }
  );
}

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
