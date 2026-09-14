/**
 * Deterministic graph context around changed review files.
 *
 * The closure is metadata for review context, not an instruction to publish
 * findings against unchanged files. Keeping it separate from the changed-file
 * bundle list preserves line-position safety while still exposing the local
 * import/dependent neighborhood to a reviewer.
 */

export interface ReviewGraphFile {
  relativePath: string;
  id: number;
}

export interface ReviewGraphImport {
  resolvedFile?: { relativePath?: string } | null;
}

export interface ReviewGraphSource {
  getFileByPath(path: string): ReviewGraphFile | null;
  getImportsWithDetails(fileId: number): ReviewGraphImport[];
  getDependents(fileId: number): ReviewGraphFile[];
}

export interface ReviewGraphClosureNode {
  path: string;
  depth: number;
  imports: string[];
  dependents: string[];
}

export interface ReviewGraphClosure {
  roots: string[];
  nodes: ReviewGraphClosureNode[];
  maxDepth: number;
  maxNodes: number;
  truncated: boolean;
  limitations: string[];
}

export interface ReviewGraphClosureOptions {
  maxDepth?: number;
  maxNodes?: number;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(`Review graph closure bound must be an integer between 0 and ${maximum}.`);
  }
  return value;
}

/** Build a bounded, sorted import/dependent closure for changed source paths. */
export function buildReviewGraphClosure(
  changedFiles: readonly string[],
  graph: ReviewGraphSource,
  options: ReviewGraphClosureOptions = {},
): ReviewGraphClosure {
  const maxDepth = boundedInteger(options.maxDepth, 1, 10);
  const maxNodes = boundedInteger(options.maxNodes, 200, 10_000);
  const roots = [...new Set(changedFiles.map(normalizePath).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );
  const queue = roots.map((path) => ({ path, depth: 0 }));
  const seen = new Set<string>();
  const nodes: ReviewGraphClosureNode[] = [];
  let truncated = false;

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current.path)) continue;
    if (seen.size >= maxNodes) {
      truncated = true;
      break;
    }
    seen.add(current.path);

    const file = graph.getFileByPath(current.path);
    if (!file) continue;
    const imports = graph
      .getImportsWithDetails(file.id)
      .map((item) => item.resolvedFile?.relativePath)
      .filter((path): path is string => typeof path === 'string' && path.length > 0)
      .map(normalizePath);
    const dependents = graph
      .getDependents(file.id)
      .map((item) => item.relativePath)
      .filter((path) => path.length > 0)
      .map(normalizePath);
    const uniqueImports = [...new Set(imports)].sort((a, b) => a.localeCompare(b));
    const uniqueDependents = [...new Set(dependents)].sort((a, b) => a.localeCompare(b));
    nodes.push({
      path: normalizePath(file.relativePath),
      depth: current.depth,
      imports: uniqueImports,
      dependents: uniqueDependents,
    });

    if (current.depth >= maxDepth) continue;
    for (const neighbor of [...uniqueImports, ...uniqueDependents]) {
      if (!seen.has(neighbor)) queue.push({ path: neighbor, depth: current.depth + 1 });
    }
  }

  nodes.sort((left, right) => left.depth - right.depth || left.path.localeCompare(right.path));
  const limitations = [
    'Graph closure describes review context; only changed files are eligible for line-level findings.',
  ];
  if (truncated) {
    limitations.push(
      `Graph closure stopped at ${maxNodes} nodes; increase maxNodes only when the review context budget permits it.`,
    );
  }
  if (nodes.some((node) => node.imports.length === 0 && node.dependents.length === 0)) {
    limitations.push(
      'Some changed paths have no indexed graph neighbors; run scan_project before treating closure absence as proof of isolation.',
    );
  }
  return { roots, nodes, maxDepth, maxNodes, truncated, limitations };
}
