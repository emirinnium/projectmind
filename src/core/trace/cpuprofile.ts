import { type NormalizedTraceEvent, type TraceConversionResult } from './types.js';

interface CpuProfileNode {
  id: string | number;
  callFrame?: {
    functionName?: unknown;
    url?: unknown;
  };
  children?: unknown;
}

/** Convert a V8 `.cpuprofile` JSON payload to sampled parent-child edges. */
export function convertCpuProfile(content: string, workloadId: string): TraceConversionResult {
  const parsed: unknown = JSON.parse(content);
  if (!isRecord(parsed) || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.samples)) {
    throw new Error('V8 cpuprofile must contain nodes[] and samples[].');
  }

  const nodes = parsed.nodes.filter(isCpuProfileNode);
  const byId = new Map(nodes.map((node) => [nodeKey(node.id), node]));
  const parentById = new Map<string, string>();
  for (const node of nodes) {
    if (!Array.isArray(node.children)) continue;
    for (const child of node.children) {
      if (typeof child === 'string' || typeof child === 'number') {
        const childKey = nodeKey(child);
        if (byId.has(childKey) && !parentById.has(childKey)) {
          parentById.set(childKey, nodeKey(node.id));
        }
      }
    }
  }

  const counts = new Map<string, number>();
  let skippedSamples = 0;
  for (const sample of parsed.samples) {
    if ((typeof sample !== 'string' && typeof sample !== 'number') || !byId.has(nodeKey(sample))) {
      skippedSamples++;
      continue;
    }
    let childKey = nodeKey(sample);
    const visited = new Set<string>();
    while (parentById.has(childKey) && !visited.has(childKey)) {
      visited.add(childKey);
      const parentKey = parentById.get(childKey)!;
      const edge = `${parentKey}\n${childKey}`;
      counts.set(edge, (counts.get(edge) ?? 0) + 1);
      childKey = parentKey;
    }
  }

  const events: NormalizedTraceEvent[] = [];
  for (const [edge, callCount] of counts) {
    const [parentKey, childKey] = edge.split('\n');
    const fromFunctionName = cpuFunctionName(byId.get(parentKey));
    const toFunctionName = cpuFunctionName(byId.get(childKey));
    if (!fromFunctionName || !toFunctionName) continue;
    events.push({
      fromFunctionName,
      toFunctionName,
      workloadId,
      callCount,
      staticMissed: false,
    });
  }
  events.sort((a, b) =>
    `${a.fromFunctionName}\0${a.toFunctionName}`.localeCompare(
      `${b.fromFunctionName}\0${b.toFunctionName}`,
    ),
  );
  return {
    format: 'cpuprofile',
    events,
    skippedRecords: skippedSamples,
    warnings: [
      'V8 cpuprofile edges are sampled observations; callCount is sample frequency, not exact invocation count.',
      ...(events.length === 0
        ? ['No named caller/callee edges could be resolved from the profile.']
        : []),
    ],
  };
}

function isCpuProfileNode(value: unknown): value is CpuProfileNode {
  return isRecord(value) && (typeof value.id === 'string' || typeof value.id === 'number');
}

function cpuFunctionName(node: CpuProfileNode | undefined): string {
  if (!node || !isRecord(node.callFrame)) return '';
  const functionName =
    typeof node.callFrame.functionName === 'string' ? node.callFrame.functionName.trim() : '';
  if (functionName && functionName !== '(root)') return functionName;
  const url = typeof node.callFrame.url === 'string' ? node.callFrame.url.trim() : '';
  return url;
}

function nodeKey(id: string | number): string {
  return `${typeof id}:${String(id)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
