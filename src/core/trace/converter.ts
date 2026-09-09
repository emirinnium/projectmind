import { convertCpuProfile } from './cpuprofile.js';
import { convertCsv } from './csv.js';
import {
  assertEventLimit,
  MAX_TRACE_BYTES,
  normalizeWorkload,
  type NormalizedTraceEvent,
  type TraceConversionFormat,
  type TraceConversionResult,
} from './types.js';

export type {
  NormalizedTraceEvent,
  TraceConversionFormat,
  TraceConversionResult,
} from './types.js';

type JsonRecord = Record<string, unknown>;

/**
 * Runtime trace adapters. The converter is pure: it parses bytes already
 * supplied by a caller and returns the normalized edge-list contract used by
 * the knowledge graph. It never reads or writes paths.
 */
export function convertTraceContent(
  content: string,
  format: TraceConversionFormat,
  workloadId = 'converted',
): TraceConversionResult {
  if (content.length > MAX_TRACE_BYTES) {
    throw new Error(`Trace input exceeds the ${MAX_TRACE_BYTES} byte safety limit.`);
  }
  const normalizedWorkload = normalizeWorkload(workloadId);
  switch (format) {
    case 'json':
      return convertJson(JSON.parse(content), normalizedWorkload, 'json');
    case 'cgr':
      return convertJsonLines(content, normalizedWorkload);
    case 'csv':
      return convertCsv(content, normalizedWorkload);
    case 'cpuprofile':
      return convertCpuProfile(content, normalizedWorkload);
  }
}

function convertJsonLines(content: string, workloadId: string): TraceConversionResult {
  const events: NormalizedTraceEvent[] = [];
  const warnings: string[] = [];
  let skippedRecords = 0;
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(
        `Invalid CGR JSONL at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const result = parseJsonTraceValue(value, workloadId, `line ${index + 1}`);
    events.push(...result.events);
    skippedRecords += result.skippedRecords;
    warnings.push(...result.warnings);
    assertEventLimit(events.length);
  }
  return { format: 'cgr', events, skippedRecords, warnings };
}

function convertJson(
  parsed: unknown,
  workloadId: string,
  format: 'json' | 'cgr',
): TraceConversionResult {
  const records = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed)
      ? Array.isArray(parsed.calls)
        ? parsed.calls
        : Array.isArray(parsed.events)
          ? parsed.events
          : [parsed]
      : [];
  const events: NormalizedTraceEvent[] = [];
  const warnings: string[] = [];
  let skippedRecords = 0;
  for (const [index, record] of records.entries()) {
    const result = parseJsonTraceValue(record, workloadId, `record ${index + 1}`);
    events.push(...result.events);
    skippedRecords += result.skippedRecords;
    warnings.push(...result.warnings);
    assertEventLimit(events.length);
  }
  return { format, events, skippedRecords, warnings };
}

function parseJsonTraceValue(
  value: unknown,
  defaultWorkload: string,
  location: string,
): Pick<TraceConversionResult, 'events' | 'skippedRecords' | 'warnings'> {
  if (!isRecord(value)) {
    return {
      events: [],
      skippedRecords: 1,
      warnings: [`Skipped ${location}: expected an object.`],
    };
  }

  const stack = readStringArray(value, ['stack', 'frames', 'callStack']);
  if (stack && stack.length > 1) {
    const callCount = readCallCount(value);
    const workload = readWorkload(value, defaultWorkload);
    return {
      events: stack.slice(0, -1).map((fromFunctionName, index) => ({
        fromFunctionName,
        toFunctionName: stack[index + 1],
        workloadId: workload,
        callCount,
        staticMissed: readBoolean(value, ['staticMissed', 'static_missed']),
      })),
      skippedRecords: 0,
      warnings: [],
    };
  }

  const fromFunctionName = readString(value, [
    'fromFunctionName',
    'from_function_name',
    'fromFunction',
    'from_function',
    'caller',
    'from',
  ]);
  const toFunctionName = readString(value, [
    'toFunctionName',
    'to_function_name',
    'toFunction',
    'to_function',
    'callee',
    'to',
  ]);
  if (!fromFunctionName || !toFunctionName) {
    return {
      events: [],
      skippedRecords: 1,
      warnings: [`Skipped ${location}: missing caller/callee function names.`],
    };
  }
  return {
    events: [
      {
        fromFunctionName,
        toFunctionName,
        workloadId: readWorkload(value, defaultWorkload),
        callCount: readCallCount(value),
        staticMissed: readBoolean(value, ['staticMissed', 'static_missed']),
      },
    ],
    skippedRecords: 0,
    warnings: [],
  };
}

function readString(record: JsonRecord, keys: string[]): string {
  for (const key of keys) {
    if (typeof record[key] === 'string' && record[key].trim()) return record[key].trim();
  }
  return '';
}

function readStringArray(record: JsonRecord, keys: string[]): string[] | null {
  for (const key of keys) {
    if (!Array.isArray(record[key])) continue;
    const values = record[key]
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim());
    if (values.length > 1 && values.every(Boolean)) return values;
  }
  return null;
}

function readWorkload(record: JsonRecord, fallback: string): string {
  return normalizeWorkload(
    readString(record, ['workloadId', 'workload_id', 'workload']) || fallback,
  );
}

function readCallCount(record: JsonRecord): number {
  const value = record.callCount ?? record.call_count ?? record.dynamic_call_count ?? record.count;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? Math.min(Math.floor(number), 1_000_000_000) : 1;
}

function readBoolean(record: JsonRecord, keys: string[]): boolean {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') return /^(true|1|yes)$/i.test(value.trim());
    if (typeof value === 'number') return value !== 0;
  }
  return false;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
