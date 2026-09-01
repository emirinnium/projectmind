import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from './types.js';
import { trackAgentAccess } from './types.js';
import {
  assembleUserContext,
  UserContextItem,
  UserContextResult,
} from '../../core/context/smart-assembler.js';
import { getSharedBroadcastService } from './intelligence.js';
import type { ExpectedChanges } from '../../core/collaboration/types.js';

/** One live intent from another agent overlapping the requested context. */
interface ConflictWarning {
  agentId: string;
  intent: string;
  targetFiles: string[];
  expiresAt: number;
  expectedChanges?: string;
}

/** Compact human-readable summary of an intent's expected changes (F17). */
function summarizeExpectedChanges(changes: ExpectedChanges | undefined): string | undefined {
  if (!changes) return undefined;
  const parts: string[] = [];
  if (changes.signatureChanges?.length) {
    parts.push(
      `${changes.signatureChanges.length} signature change(s): ${changes.signatureChanges.map((s) => s.function).join(', ')}`,
    );
  }
  if (changes.typeChanges?.length) {
    parts.push(
      `${changes.typeChanges.length} type change(s): ${changes.typeChanges.map((t) => t.type).join(', ')}`,
    );
  }
  if (changes.notes?.length) {
    parts.push(changes.notes.join('; '));
  }
  return parts.length > 0 ? parts.join(' | ') : undefined;
}

/**
 * F38b: live conflict warnings from OTHER agents' broadcast intents that
 * overlap the requested file (or its cheap import neighborhood). FAIL-SAFE:
 * any error — missing DB, missing table, malformed row — returns [] so
 * get_context itself never breaks.
 */
function collectConflictWarnings(deps: McpDependencies, watchPaths: string[]): ConflictWarning[] {
  try {
    if (!deps.db || watchPaths.length === 0) return [];
    const me = deps.agentName ?? 'mcp-client';
    const service = getSharedBroadcastService(deps.db);
    const normalized = new Set(watchPaths.map((p) => p.split('\\').join('/')));
    const warnings: ConflictWarning[] = [];
    for (const intent of service.getActiveIntents(me)) {
      if (intent.intentType === 'read') continue; // read-only never conflicts
      const overlap = intent.targetFiles.some((f) => normalized.has(f.split('\\').join('/')));
      if (!overlap) continue;
      warnings.push({
        agentId: intent.agentId,
        intent: intent.intentType,
        targetFiles: intent.targetFiles,
        expiresAt: intent.timestamp + (intent.ttlSeconds ?? 300) * 1000,
        expectedChanges: summarizeExpectedChanges(intent.expectedChanges) ?? intent.description,
      });
      if (warnings.length >= 10) break; // bounded — context budget protection
    }
    return warnings;
  } catch {
    return [];
  }
}

export function registerGetContextTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'get_context',
    {
      title: 'Get File Context',
      description:
        'Get context for a file you are about to EDIT — use BEFORE writing code.\n' +
        'Returns: imports (resolved + unresolved), reverse dependencies (who imports this file), similar files, function/class structure, and patterns observed elsewhere in the project.\n' +
        'WHEN to call: before editing a file, when you need to understand who depends on it, or to find similar implementations to mimic.\n' +
        'WHEN NOT to call: when you just need symbol references (use refs via projectmind_run_cli — or run_cli on clients without the prefix) or to find similar code semantically (use find_file_by_import or embedding search).\n' +
        'Requires: scan_project to have indexed the file at least once.',
      inputSchema: {
        filePath: z.string().describe('Path of the file to get context for'),
        limit: z.number().default(5).describe('Maximum number of context items to return'),
        includeImports: z.boolean().default(true).describe('Include import/dependency information'),
        includeDependents: z
          .boolean()
          .default(true)
          .describe('Include reverse dependencies (files that import this file)'),
        includeSimilar: z
          .boolean()
          .default(true)
          .describe('Include similar files based on embeddings'),
        maxTokens: z
          .number()
          .optional()
          .describe('Soft token budget (~chars/4). When set, list sections are trimmed to fit.'),
        task: z
          .string()
          .optional()
          .describe(
            'What you are about to do (e.g. "add rate limiting to login endpoint"). When set, a ranked smartContext section is added — files to look at next, with per-item reasons.',
          ),
      },
    },
    async (args) => {
      try {
        const file = deps.kg.getFileByPath(args.filePath);
        if (!file) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  error: 'File not found in knowledge graph. Run scan_project first.',
                }),
              },
            ],
          };
        }

        // Track agent access for coverage
        if (deps.agentName) {
          trackAgentAccess(deps.kg, deps.agentName, args.filePath);
        }

        // Get imports with resolution status
        const imports = deps.kg.getImportsWithDetails(file.id);
        const resolvedImports = imports.filter((i) => i.resolvedFile);
        const unresolvedImports = imports.filter((i) => !i.resolvedFile);

        // Token-budget aware caps: when maxTokens is set, list sections are
        // trimmed up-front so the serialized response stays within budget.
        // ~4 chars/token heuristic, ~90 chars reserved per list entry.
        let itemCap = args.limit;
        if (args.maxTokens !== undefined && args.maxTokens > 0) {
          const budgetItems = Math.floor((args.maxTokens * 4) / 90);
          itemCap = Math.max(1, Math.min(args.limit, budgetItems));
        }

        // Get dependents (reverse dependencies)
        const allDependents = args.includeDependents ? deps.kg.getDependents(file.id) : [];
        const dependents = allDependents.slice(0, itemCap);

        // Get similar files
        let similarFiles: (typeof file)[] = [];
        if (args.includeSimilar) {
          const fileEmbedding = deps.kg.getFileEmbedding ? deps.kg.getFileEmbedding(file.id) : null;
          if (fileEmbedding) {
            similarFiles = deps.kg.findSimilarFiles(fileEmbedding, 0.7, itemCap);
          }
        }

        // Get functions and classes
        const functions = deps.kg.getFunctions(file.id);
        const classes = deps.kg.getClasses(file.id);

        // Get circular dependencies involving this file
        const cycles = deps.kg.findCircularDependencies?.() || [];
        const fileCycles = cycles.filter((cycle) => cycle.includes(file.relativePath));

        // F38b: live conflict warnings from other agents' broadcast intents,
        // covering the file itself plus its cheap import neighborhood.
        const watchPaths: string[] = [file.relativePath, args.filePath];
        for (const i of resolvedImports) {
          if (i.resolvedFile?.relativePath) watchPaths.push(i.resolvedFile.relativePath);
        }
        for (const d of dependents) {
          watchPaths.push(d.relativePath);
        }
        const conflictWarnings = collectConflictWarnings(deps, watchPaths);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  file: {
                    path: file.relativePath,
                    language: file.language,
                    sizeBytes: file.sizeBytes,
                    cognitiveLoad: file.cognitiveLoad,
                    agentTouched: file.agentTouched,
                    agentTouchedBy: file.agentTouchedBy,
                    agentTouchedAt: file.agentTouchedAt,
                    lastScanned: file.lastScanned,
                    hash: file.hash,
                  },
                  imports: {
                    total: imports.length,
                    resolved: resolvedImports.length,
                    unresolved: unresolvedImports.length,
                    details: imports.map((i) => ({
                      source: i.source,
                      kind: i.kind,
                      resolved: !!i.resolvedFile,
                      resolvedPath: i.resolvedFile?.relativePath,
                    })),
                  },
                  dependents: dependents.map((d) => ({
                    path: d.relativePath,
                    cognitiveLoad: d.cognitiveLoad,
                    agentTouched: d.agentTouched,
                    agentTouchedBy: d.agentTouchedBy,
                  })),
                  similarFiles: similarFiles.map((f) => ({
                    path: f.relativePath,
                    language: f.language,
                    cognitiveLoad: f.cognitiveLoad,
                    agentTouched: f.agentTouched,
                  })),
                  structure: {
                    functions: functions.map((fn) => ({
                      name: fn.name,
                      signature: fn.signature,
                      complexity: fn.complexity,
                      startLine: fn.startLine,
                      endLine: fn.endLine,
                    })),
                    classes: classes.map((cls) => ({
                      name: cls.name,
                      methodsCount: cls.methodsCount,
                      propertiesCount: cls.propertiesCount,
                    })),
                  },
                  circularDependencies: fileCycles,
                  patterns: file.patterns || [],
                  // F38b: other agents' live intents overlapping this context.
                  // Only present when at least one potential conflict exists.
                  ...(conflictWarnings.length > 0 ? { conflictWarnings } : {}),
                  // Task-aware ranked "what to look at next" section. Only
                  // present when the caller passed a task string.
                  ...(args.task
                    ? {
                        smartContext: assembleUserContext(deps.kg, {
                          fileId: file.id,
                          relativePath: file.relativePath,
                          cognitiveLoad: file.cognitiveLoad,
                          task: args.task,
                          maxTokens: args.maxTokens,
                          limit: Math.max(itemCap, 8),
                        }),
                      }
                    : {}),
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
                  filePath: args.filePath,
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
