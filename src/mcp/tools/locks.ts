import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from './types.js';
import { predictMergeRisk } from '../../core/coordination/risk.js';
import { logger } from '../../utils/logger.js';

// Stale lock cleanup interval (5 minutes)
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Clean up stale locks (expired TTL).
 */
async function cleanupStaleLocks(kg: McpDependencies['kg']): Promise<void> {
  try {
    const purgedCount = kg.purgeExpiredLocks();
    if (purgedCount === 0) return;
    
    logger.info(`Cleaned up ${purgedCount} stale locks.`);
  } catch (error) {
    logger.warn('Failed to clean up stale locks:', { error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Start periodic stale lock cleanup.
 */
function startStaleLockCleanup(kg: McpDependencies['kg']): void {
  setInterval(() => {
    cleanupStaleLocks(kg).catch(error => {
      logger.error('Stale lock cleanup failed:', { error });
    });
  }, CLEANUP_INTERVAL_MS);
}

/**
 * agent_locks — multi-agent coordination surface.
 *
 * Advisory file locking so two agents don't silently edit the same file:
 *   acquire — lock a file for this agent (TTL'd, refreshed on re-acquire)
 *   release — release a file (owner only)
 *   list    — all live locks
 *   check   — batch-check files before editing; reports who holds conflicts
 *
 * Locks are COORDINATION hints, not enforcement: the CLI can always write.
 */

const inputSchema = {
  action: z.enum(['acquire', 'release', 'list', 'check']).describe('acquire=lock a file, release=unlock (owner only), list=all live locks, check=batch conflict check before editing'),
  filePath: z.string().optional().describe('File path to lock/release (required for acquire/release)'),
  files: z.array(z.string()).optional().describe('File paths to check (required for check)'),
  agentName: z.string().describe('Your agent name (e.g. "cursor-agent", "claude-code")'),
  ttlMinutes: z.number().default(30).describe('Lock TTL in minutes for acquire (1-1440)'),
  reason: z.string().optional().describe('Why you are locking this file (shown to other agents)'),
};

function json(result: object): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

export function registerAgentLocksTool(server: McpServer, deps: McpDependencies): void {
  // Start periodic stale lock cleanup
  startStaleLockCleanup(deps.kg);

  server.registerTool(
    'agent_locks',
    {
      title: 'Agent File Locks',
      description:
        'Coordinate with OTHER agents working in the same repo.\n' +
        'WHEN to call: BEFORE editing, run action=check over the files you plan to touch; if a conflict comes back, wait or pick another approach instead of colliding. Then action=acquire your primary target, and action=release when done.\n' +
        'Locks are TTL-based advisory hints (crashed agents cannot deadlock a file), NOT write enforcement.',
      inputSchema,
    },
    async (args) => {
      try {
        const kg = deps.kg;

        switch (args.action) {
          case 'acquire': {
            if (!args.filePath) return json({ success: false, error: "action='acquire' requires filePath." });
            const result = kg.acquireFileLock(args.filePath, args.agentName, { ttlMinutes: args.ttlMinutes, reason: args.reason });
            if (result.status === 'held') {
              return json({
                success: false,
                status: 'held',
                message: `File is locked by ANOTHER agent — do not edit it now.`,
                heldBy: result.heldBy,
                suggestion: 'Wait until expiresAt, pick a different file/approach, or coordinate out-of-band.',
              });
            }
            return json({
              success: true,
              status: 'acquired',
              lock: result.lock,
              reminder: `Call action='release' with the same agentName when done.`,
            });
          }

          case 'release': {
            if (!args.filePath) return json({ success: false, error: "action='release' requires filePath." });
            const result = kg.releaseFileLock(args.filePath, args.agentName);
            return json({ success: result.status === 'released', ...result });
          }

          case 'list': {
            const locks = kg.getActiveLocks(args.agentName === '*' ? undefined : args.agentName);
            return json({
              success: true,
              note: args.agentName === '*' ? undefined : 'Filtered to your locks. Pass agentName="*" to see every agent.',
              count: locks.length,
              locks,
            });
          }

          case 'check': {
            if (!args.files || args.files.length === 0) return json({ success: false, error: "action='check' requires files (array)." });
            const report = kg.checkFileConflicts(args.files.slice(0, 100), args.agentName);
            // Merge-risk prediction: even with zero lock conflicts, my edits
            // can collide with another agent's territory through the
            // dependency graph. Surface that before work starts.
            const risk = predictMergeRisk(kg, {
              myFiles: args.files.map((f) => f.split('\\').join('/')),
              otherHeldFiles: report.conflicts.map((c) => c.filePath),
            });
            return json({
              success: true,
              ...report,
              risk,
              verdict:
                report.conflicts.length === 0 && risk.level === 'low'
                  ? 'clear — safe to proceed'
                  : `conflicts: ${report.conflicts.length}, merge-risk: ${risk.level} — coordinate before editing`,
            });
          }
        }
      } catch (error) {
        return json({ success: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
  );
}
