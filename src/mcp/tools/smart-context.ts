import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from './types.js';
import { assembleUserContext, UserContextResult } from '@/core/context/user-context-assembler.js';

/**
 * suggest_next_files — task-aware "what should I read next?" ranking.
 *
 * Given the file I'm about to work on (by `relativePath` or knowledge-graph
 * `fileId`) plus an optional free-text `task`, ranks which files to look at
 * NEXT using the Smart Context Assembler (src/core/context/smart-assembler.ts):
 *
 *   1. Direct dependents          — who imports this file (breaks first)
 *   2. Transitive dependents      — the blast-radius closure
 *   3. Semantic neighbors         — embedding similarity (same purpose)
 *   4. Test files + task keywords — cheap lexical boosts over the pooled set
 *
 * This is a thin, read-only wrapper around the core `assembleUserContext`
 * engine. It resolves the target file to the (fileId, relativePath,
 * cognitiveLoad) triple the engine requires, then returns the engine's real
 * result shape verbatim: `{ task, items: [{ path, score, reasons[] }],
 * consideredFiles, note }` — deterministic for a fixed knowledge-graph
 * snapshot (no LLM involved).
 */

/** Input accepted by the suggest_next_files tool. */
export interface SuggestNextFilesArgs {
  /** Relative path of the file I'm about to work on (alternative to fileId). */
  relativePath?: string;
  /** Knowledge-graph file id of the target (alternative to relativePath). */
  fileId?: string;
  /** Free-text description of the task — used for cheap keyword boosts. */
  task?: string;
  /** Maximum number of suggestions to return (engine default: 8). */
  limit?: number;
}

/**
 * Resolve the target file from either `relativePath` or `fileId` into the
 * `(fileId, relativePath, cognitiveLoad)` triple `assembleSmartContext`
 * requires.
 *
 * `relativePath` is resolved through the knowledge graph's path index
 * (`getFileByPath` matches both absolute `path` and `relative_path`).
 * `fileId` is resolved by scanning the project's file list — no DB handle is
 * needed, so the wrapper stays dependency-light (only `deps.kg` is read).
 *
 * @throws {Error} When neither identifier is given, the id is malformed, or
 *   the target is not present in the knowledge graph (run scan_project first).
 */
function resolveTarget(
  deps: McpDependencies,
  args: SuggestNextFilesArgs,
): { fileId: number; relativePath: string; cognitiveLoad: number } {
  if (args.relativePath !== undefined && args.relativePath.trim() !== '') {
    const file = deps.kg.getFileByPath(args.relativePath);
    if (!file) {
      throw new Error(
        `suggest_next_files: file '${args.relativePath}' not found in the knowledge graph. Run scan_project first.`,
      );
    }
    return { fileId: file.id, relativePath: file.relativePath, cognitiveLoad: file.cognitiveLoad };
  }

  if (args.fileId !== undefined && args.fileId.trim() !== '') {
    const id = Number(args.fileId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error(
        `suggest_next_files: invalid fileId '${args.fileId}' — expected a positive integer.`,
      );
    }
    const file = deps.kg.getAllFiles().find((f) => f.id === id);
    if (!file) {
      throw new Error(
        `suggest_next_files: file id ${id} not found in the knowledge graph. Run scan_project first.`,
      );
    }
    return { fileId: file.id, relativePath: file.relativePath, cognitiveLoad: file.cognitiveLoad };
  }

  throw new Error('suggest_next_files: either relativePath or fileId is required.');
}

/**
 * Rank which files to read next when working on a target file for a task.
 *
 * Pure and dependency-light (only `deps.kg` is read — no DB handle, no
 * filesystem, no network), so it is directly unit-testable — mirroring the
 * `predictMergeRiskForTool` / `semanticSearchForTool` pattern of exporting the
 * core logic for tests.
 */
export function suggestNextFilesForTool(
  deps: McpDependencies,
  args: SuggestNextFilesArgs,
): UserContextResult {
  const target = resolveTarget(deps, args);
  return assembleUserContext(deps.kg, {
    fileId: target.fileId,
    relativePath: target.relativePath,
    cognitiveLoad: target.cognitiveLoad,
    task: args.task,
    limit: args.limit,
  });
}

export function registerSuggestNextFilesTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'suggest_next_files',
    {
      title: 'Suggest Next Files',
      description:
        'Rank which files you should read NEXT when working on a target file for a task.\n' +
        'WHEN to call: at the START of a task — "I\'m about to work on src/x.ts for task Y — what should I read next?"\n' +
        'Ranks direct + transitive dependents (who breaks first), semantic neighbors, test files, and task-keyword matches.\n' +
        'Pass either relativePath or fileId; task is optional but improves ranking.\n' +
        'Returns { task, items: [{ path, score, reasons[] }], consideredFiles, note } — deterministic, no LLM.',
      inputSchema: {
        relativePath: z
          .string()
          .optional()
          .describe('Relative path of the file you are about to work on (e.g. "src/x.ts")'),
        fileId: z
          .string()
          .optional()
          .describe('Knowledge-graph file id of the target (alternative to relativePath)'),
        task: z
          .string()
          .optional()
          .describe(
            'Free-text description of the task (e.g. "add rate limiting") — used for keyword boosts',
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('Maximum number of suggestions (default 8)'),
      },
    },
    async (args) => {
      try {
        const result = suggestNextFilesForTool(deps, {
          relativePath: args.relativePath,
          fileId: args.fileId,
          task: args.task,
          limit: args.limit,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
        };
      }
    },
  );
}
