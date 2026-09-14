import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { KnowledgeGraph } from '../../../storage/knowledge-graph.js';
import { assertProjectPath } from '../../security/path-security.js';

export interface IncrementalPropagationResult {
  files: string[];
  dependencyFiles: string[];
  depth: number;
}

/**
 * Expand content-changed files to bounded reverse dependents.
 *
 * Reprocessing callers is required when a target's functions change: call
 * edges point at function rows and are removed by the target upsert. This is
 * deliberately bounded and project-confined; a full scan remains available
 * for migrations or parser/provider changes.
 */
export function expandIncrementalDependencyFiles(
  changedFiles: readonly string[],
  root: string,
  kg: Pick<KnowledgeGraph, 'getFileByPath' | 'getDependents'>,
  maxDepth = 1,
): IncrementalPropagationResult {
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 5) {
    throw new Error('Incremental dependency depth must be an integer between 0 and 5.');
  }
  const primary = [
    ...new Set(
      changedFiles.map((file) => (isAbsolute(file) ? resolve(file) : resolve(root, file))),
    ),
  ];
  if (maxDepth === 0 || primary.length === 0) {
    return { files: primary, dependencyFiles: [], depth: maxDepth };
  }

  const all = new Set(primary);
  const dependencyFiles: string[] = [];
  const visited = new Set<number>();
  const queue: Array<{ path: string; depth: number }> = primary.map((path) => ({
    path,
    depth: 0,
  }));

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= maxDepth) continue;
    const file = kg.getFileByPath(current.path);
    if (!file || visited.has(file.id)) continue;
    visited.add(file.id);
    for (const dependent of kg.getDependents(file.id)) {
      try {
        const safePath = assertProjectPath(dependent.relativePath || dependent.path, root, {
          mustExist: true,
          rejectIgnored: true,
        });
        if (!existsSync(safePath) || all.has(safePath)) continue;
        all.add(safePath);
        dependencyFiles.push(safePath);
        queue.push({ path: safePath, depth: current.depth + 1 });
      } catch {
        // A stale/outside/ignored graph row is not allowed to widen a scan.
      }
    }
  }

  return { files: [...all], dependencyFiles, depth: maxDepth };
}
