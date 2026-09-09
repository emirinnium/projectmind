import {
  assertEventLimit,
  normalizeWorkload,
  type NormalizedTraceEvent,
  type TraceConversionResult,
} from './types.js';

export function convertCsv(content: string, workloadId: string): TraceConversionResult {
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) throw new Error('CSV input is empty.');
  const header = parseCsvLine(lines[0]);
  const column = (name: string): number =>
    header.findIndex((value) => value.trim().toLowerCase() === name.toLowerCase());
  const fromColumn = findColumn(column, [
    'fromFunctionName',
    'from_function_name',
    'from',
    'caller',
  ]);
  const toColumn = findColumn(column, ['toFunctionName', 'to_function_name', 'to', 'callee']);
  if (fromColumn < 0 || toColumn < 0) {
    throw new Error('CSV must have caller/from and callee/to columns.');
  }
  const workloadColumn = findColumn(column, ['workloadId', 'workload_id', 'workload']);
  const countColumn = findColumn(column, ['callCount', 'call_count', 'count']);
  const missedColumn = findColumn(column, ['staticMissed', 'static_missed']);
  const events: NormalizedTraceEvent[] = [];
  const warnings: string[] = [];
  let skippedRecords = 0;

  for (let index = 1; index < lines.length; index++) {
    const cells = parseCsvLine(lines[index]);
    const fromFunctionName = cells[fromColumn]?.trim() ?? '';
    const toFunctionName = cells[toColumn]?.trim() ?? '';
    if (!fromFunctionName || !toFunctionName) {
      skippedRecords++;
      warnings.push(`Skipped CSV row ${index + 1}: missing caller/callee function names.`);
      continue;
    }
    const rawCount = countColumn >= 0 ? Number(cells[countColumn]?.trim()) : 1;
    events.push({
      fromFunctionName,
      toFunctionName,
      workloadId:
        workloadColumn >= 0 && cells[workloadColumn]?.trim()
          ? normalizeWorkload(cells[workloadColumn].trim())
          : workloadId,
      callCount: Number.isFinite(rawCount) && rawCount > 0 ? Math.floor(rawCount) : 1,
      staticMissed:
        missedColumn >= 0 ? /^(true|1|yes)$/i.test(cells[missedColumn]?.trim() ?? '') : false,
    });
    assertEventLimit(events.length);
  }
  return { format: 'csv', events, skippedRecords, warnings };
}

function findColumn(column: (name: string) => number, names: string[]): number {
  for (const name of names) {
    const found = column(name);
    if (found >= 0) return found;
  }
  return -1;
}

/** Parse one RFC 4180-style row, including escaped quotes and commas. */
export function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index++;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      cells.push(value);
      value = '';
    } else {
      value += char;
    }
  }
  if (quoted) throw new Error('CSV contains an unterminated quoted field.');
  cells.push(value);
  return cells;
}
