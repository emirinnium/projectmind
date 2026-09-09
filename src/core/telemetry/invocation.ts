export interface InvocationMetrics {
  tool: string;
  durationMs: number;
  inputBytes: number;
  outputBytes: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  cold: boolean;
  ok: boolean;
}

const seenTools = new Set<string>();
const history = new Map<string, InvocationMetrics[]>();

function jsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
  } catch (error) {
    void error;
    return 0;
  }
}

/** Instrument a tool without changing its default response contract. */
export async function measureInvocation<T>(
  tool: string,
  input: unknown,
  fn: () => Promise<T>,
): Promise<{ value: T; metrics: InvocationMetrics }> {
  const started = performance.now();
  const cold = !seenTools.has(tool);
  seenTools.add(tool);
  let ok = true;
  try {
    const value = await fn();
    const metrics = createMetrics(tool, started, input, value, cold, ok);
    remember(metrics);
    return { value, metrics };
  } catch (error) {
    ok = false;
    const metrics = createMetrics(
      tool,
      started,
      input,
      { error: error instanceof Error ? error.message : String(error) },
      cold,
      ok,
    );
    remember(metrics);
    throw error;
  }
}

function createMetrics(
  tool: string,
  started: number,
  input: unknown,
  output: unknown,
  cold: boolean,
  ok: boolean,
): InvocationMetrics {
  const inputBytes = jsonBytes(input);
  const outputBytes = jsonBytes(output);
  return {
    tool,
    durationMs: Math.max(0, Math.round((performance.now() - started) * 100) / 100),
    inputBytes,
    outputBytes,
    estimatedInputTokens: Math.ceil(inputBytes / 4),
    estimatedOutputTokens: Math.ceil(outputBytes / 4),
    cold,
    ok,
  };
}

function remember(metrics: InvocationMetrics): void {
  const entries = history.get(metrics.tool) ?? [];
  entries.push(metrics);
  if (entries.length > 1000) entries.shift();
  history.set(metrics.tool, entries);
}

export function summarizeInvocationMetrics(tool?: string): Record<
  string,
  {
    count: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    avgOutputBytes: number;
    avgOutputTokens: number;
    errors: number;
  }
> {
  const selected = tool ? [[tool, history.get(tool) ?? []] as const] : [...history.entries()];
  const percentile = (values: number[], p: number): number => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
  };
  return Object.fromEntries(
    selected.map(([name, entries]) => {
      const durations = entries.map((entry) => entry.durationMs);
      return [
        name,
        {
          count: entries.length,
          p50Ms: percentile(durations, 0.5),
          p95Ms: percentile(durations, 0.95),
          p99Ms: percentile(durations, 0.99),
          avgOutputBytes:
            entries.length === 0
              ? 0
              : Math.round(
                  entries.reduce((sum, entry) => sum + entry.outputBytes, 0) / entries.length,
                ),
          avgOutputTokens:
            entries.length === 0
              ? 0
              : Math.round(
                  entries.reduce((sum, entry) => sum + entry.estimatedOutputTokens, 0) /
                    entries.length,
                ),
          errors: entries.filter((entry) => !entry.ok).length,
        },
      ];
    }),
  );
}

export function resetInvocationMetrics(): void {
  seenTools.clear();
  history.clear();
}
