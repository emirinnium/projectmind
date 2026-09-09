export type TraceConversionFormat = 'json' | 'csv' | 'cgr' | 'cpuprofile';

export interface NormalizedTraceEvent {
  fromFunctionName: string;
  toFunctionName: string;
  workloadId: string;
  callCount: number;
  staticMissed: boolean;
}

export interface TraceConversionResult {
  format: TraceConversionFormat;
  events: NormalizedTraceEvent[];
  skippedRecords: number;
  warnings: string[];
}

export const MAX_TRACE_BYTES = 25 * 1024 * 1024;
export const MAX_TRACE_EVENTS = 100_000;

export function normalizeWorkload(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return 'converted';
  return trimmed.slice(0, 200);
}

export function assertEventLimit(count: number): void {
  if (count > MAX_TRACE_EVENTS) {
    throw new Error(`Converted trace exceeds the ${MAX_TRACE_EVENTS} event safety limit.`);
  }
}
