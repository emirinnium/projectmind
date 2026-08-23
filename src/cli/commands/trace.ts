import { Command } from 'commander';
import { withService, asyncHandler, output } from '@/cli/utils/shared.js';
import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';

const TraceCallSchema = z.object({
  fromFunctionName: z.string().min(1),
  toFunctionName: z.string().min(1),
  workloadId: z.string().min(1).optional(),
  callCount: z.number().int().positive().optional(),
  staticMissed: z.boolean().optional(),
});

type TraceCall = z.infer<typeof TraceCallSchema>;

export function createTraceCommand(): Command {
  const traceCmd = new Command('trace')
    .description('Runtime call tracing: ingest test traces and dynamic call data into the knowledge graph');

  traceCmd
    .command('ingest <file>')
    .description('Ingest a trace JSON file into the knowledge graph')
    .option('-w, --workload-id <id>', 'Workload identifier for this trace')
    .option('-c, --clear', 'Clear existing dynamic calls before ingest')
    .action(asyncHandler(async (file: string, opts: { workloadId?: string; clear?: boolean }) => {
      await withService(['scale'], async (ctx) => {
        const kg = ctx.kg;
        const workloadId = opts.workloadId || `trace-${Date.now()}`;

        if (!existsSync(file)) {
          output.error(`Trace file not found: ${file}`);
          process.exit(1);
        }

        let raw: unknown;
        try {
          const content = readFileSync(file, 'utf-8');
          raw = JSON.parse(content);
        } catch (e) {
          output.error(`Invalid trace file: ${e instanceof Error ? e.message : e}`);
          process.exit(1);
        }

        const parsed = Array.isArray(raw) ? raw : (raw as { calls?: unknown[]; events?: unknown[] }).calls || (raw as { calls?: unknown[]; events?: unknown[] }).events || [];
        const calls: TraceCall[] = [];
        for (const item of parsed) {
          const result = TraceCallSchema.safeParse(item);
          if (!result.success) {
            output.error(`Invalid trace event: ${result.error.message}`);
            process.exit(1);
          }
          calls.push(result.data);
        }

        if (opts.clear) {
          const cleared = kg.clearDynamicCalls(workloadId);
          output.info(`Cleared ${cleared} existing dynamic calls for workload ${workloadId}`);
        }

        output.info(`Ingesting ${calls.length} trace events with workload ${workloadId}...`);
        const result = kg.ingestDynamicCalls(calls.map((c) => ({
          ...c,
          workloadId: c.workloadId || workloadId,
        })));

        if (result.errors.length > 0) {
          output.warn(`Ingested with ${result.errors.length} errors:`);
          for (const err of result.errors.slice(0, 10)) {
            output.kv('  Error', err);
          }
        }

        output.section('Trace Ingestion Summary');
        output.kv('Workload ID', workloadId);
        output.kv('Inserted', result.inserted);
        output.kv('Updated', result.updated);
        output.kv('Errors', result.errors.length);

        if (result.inserted > 0 || result.updated > 0) {
          output.success(`Dynamic trace data ingested successfully.`);
        }
      });
    }));

  traceCmd
    .command('convert <input>')
    .description('Normalize a trace-events JSON file into ProjectMind ingest format')
    .option('--format <fmt>', 'Input format: json (cgr|pprof planned)', 'json')
    .option('-o, --output <file>', 'Output file path')
    .action(asyncHandler(async (input: string, opts: { format: string; output?: string }) => {
      if (opts.format !== 'json') {
        throw new Error(`Converter for '${opts.format}' is not implemented yet (supported: json).`);
      }
      const { readFileSync, writeFileSync } = await import('node:fs');
      const raw = JSON.parse(readFileSync(input, 'utf-8')) as
        | unknown[]
        | { events?: unknown[] };
      const events = Array.isArray(raw) ? raw : (raw.events ?? []);
      const normalized = (events as Array<Record<string, unknown>>)
        .filter((e) => e && typeof e.fromFunctionName === 'string' && typeof e.toFunctionName === 'string')
        .map((e) => ({
          fromFunctionName: String(e.fromFunctionName),
          toFunctionName: String(e.toFunctionName),
          workloadId: typeof e.workloadId === 'string' ? e.workloadId : 'converted',
          callCount: typeof e.callCount === 'number' ? e.callCount : 1,
          staticMissed: Boolean(e.staticMissed),
        }));
      const out = JSON.stringify(normalized, null, 2);
      if (opts.output) {
        writeFileSync(opts.output, out);
        output.success(`Converted ${normalized.length} events -> ${opts.output}`);
      } else {
        console.log(out);
      }
    }));

  traceCmd
    .command('show')
    .description('Show dynamic call trace data for the current project')
    .option('-w, --workload-id <id>', 'Filter by workload ID')
    .option('--static-missed', 'Show only static-missed calls')
    .action(asyncHandler(async (opts: { workloadId?: string; staticMissed?: boolean }) => {
      await withService(['scale'], async (ctx) => {
        const kg = ctx.kg;
        let calls: Array<{
          fromFunctionId: number;
          toFunctionId: number;
          callCount: number;
          staticMissed: boolean;
          workloadId: string;
          fromFunctionName: string;
          toFunctionName: string;
        }>;

        if (opts.workloadId) {
          calls = kg.getDynamicCalls(opts.workloadId);
        } else if (opts.staticMissed) {
          calls = kg.getStaticMissedCalls().map((c) => ({
            fromFunctionId: 0,
            toFunctionId: 0,
            callCount: c.callCount,
            staticMissed: true,
            workloadId: c.workloadId,
            fromFunctionName: c.fromFunctionName,
            toFunctionName: c.toFunctionName,
          }));
        } else {
          calls = kg.getAllDynamicCalls();
        }

        output.section(`Dynamic Calls (${calls.length})`);
        for (const c of calls.slice(0, 50)) {
          const missed = c.staticMissed ? ' [STATIC MISSED]' : '';
          output.kv(
            `${c.fromFunctionName} -> ${c.toFunctionName}`,
            `count=${c.callCount}, workload=${c.workloadId}${missed}`
          );
        }

        if (calls.length > 50) {
          output.info(`... and ${calls.length - 50} more. Use --workload-id to filter.`);
        }
      });
    }));

  traceCmd
    .command('clear')
    .description('Clear dynamic call trace data')
    .option('-w, --workload-id <id>', 'Clear only this workload')
    .action(asyncHandler(async (opts: { workloadId?: string }) => {
      await withService(['scale'], async (ctx) => {
        const kg = ctx.kg;

        if (opts.workloadId) {
          const cleared = kg.clearDynamicCalls(opts.workloadId);
          output.success(`Cleared ${cleared} dynamic calls for workload ${opts.workloadId}`);
        } else {
          const cleared = kg.clearAllDynamicCalls();
          output.success(`Cleared ${cleared} dynamic calls across all workloads`);
        }
      });
    }));

  return traceCmd;
}
