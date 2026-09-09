import { Command } from 'commander';
import { withService, asyncHandler, output, loadConfig } from '@/cli/utils/shared.js';
import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { confineToProject } from '@/mcp/tools/_shared.js';
import { convertTraceContent, type TraceConversionFormat } from '@/core/trace/converter.js';

const TraceCallSchema = z.object({
  fromFunctionName: z.string().min(1),
  toFunctionName: z.string().min(1),
  workloadId: z.string().min(1).optional(),
  callCount: z.number().int().positive().optional(),
  staticMissed: z.boolean().optional(),
});

type TraceCall = z.infer<typeof TraceCallSchema>;

interface TraceRawEvent {
  fromFunctionName?: string;
  toFunctionName?: string;
  workloadId?: string;
  callCount?: number;
  staticMissed?: boolean;
}
interface TraceInputFile {
  calls?: TraceRawEvent[];
  events?: TraceRawEvent[];
}

export function createTraceCommand(): Command {
  const traceCmd = new Command('trace').description(
    'Runtime call tracing: ingest test traces and dynamic call data into the knowledge graph',
  );

  traceCmd.action(() => {
    traceCmd.outputHelp();
  });

  traceCmd
    .command('ingest <file>')
    .description('Ingest a trace JSON file into the knowledge graph')
    .option('-w, --workload-id <id>', 'Workload identifier for this trace')
    .option('-c, --clear', 'Clear existing dynamic calls before ingest')
    .action(
      asyncHandler(async (file: string, opts: { workloadId?: string; clear?: boolean }) => {
        await withService(['scale'], async (ctx) => {
          const kg = ctx.kg;
          const tracePath = confineToProject(file, loadConfig().projectRoot);
          const workloadId = opts.workloadId || `trace-${Date.now()}`;

          if (!existsSync(tracePath)) {
            throw new Error(`Trace file not found: ${tracePath}`);
          }

          let raw: TraceInputFile | TraceRawEvent[] = [];
          try {
            const content = readFileSync(tracePath, 'utf-8');
            raw = JSON.parse(content) as TraceInputFile | TraceRawEvent[];
          } catch (e) {
            throw new Error(`Invalid trace file: ${e instanceof Error ? e.message : e}`);
          }

          const parsed = Array.isArray(raw) ? raw : raw.calls || raw.events || [];
          const calls: TraceCall[] = [];
          for (const item of parsed) {
            const result = TraceCallSchema.safeParse(item);
            if (!result.success) {
              throw new Error(`Invalid trace event: ${result.error.message}`);
            }
            calls.push(result.data);
          }

          if (opts.clear) {
            const cleared = kg.clearDynamicCalls(workloadId);
            output.info(`Cleared ${cleared} existing dynamic calls for workload ${workloadId}`);
          }

          output.info(`Ingesting ${calls.length} trace events with workload ${workloadId}...`);
          const result = kg.ingestDynamicCalls(
            calls.map((c) => ({
              ...c,
              workloadId: c.workloadId || workloadId,
            })),
          );

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
      }),
    );

  traceCmd
    .command('convert <input>')
    .description('Normalize a trace-events file into ProjectMind ingest format')
    .option(
      '--format <fmt>',
      'Input format: json|csv|cgr|cpuprofile (Code-Graph-RAG JSONL or V8 profile)',
      'json',
    )
    .option('-w, --workload-id <id>', 'Default workload identifier for records without one')
    .option('-o, --output <file>', 'Output file path')
    .action(
      asyncHandler(
        async (input: string, opts: { format: string; workloadId?: string; output?: string }) => {
          const { writeFileSync } = await import('node:fs');
          const root = loadConfig().projectRoot;
          const inputPath = confineToProject(input, root);
          const outputPath = opts.output ? confineToProject(opts.output, root) : undefined;
          const supportedFormats: TraceConversionFormat[] = ['json', 'csv', 'cgr', 'cpuprofile'];
          if (!supportedFormats.includes(opts.format as TraceConversionFormat)) {
            throw new Error(
              `Unsupported trace input format: ${opts.format}. Use --format json, csv, cgr, or cpuprofile.`,
            );
          }

          const format = opts.format as TraceConversionFormat;
          const content = readFileSync(inputPath, 'utf-8');
          const result = convertTraceContent(content, format, opts.workloadId);
          const out = JSON.stringify(result.events, null, 2);
          if (outputPath) {
            writeFileSync(outputPath, out);
            output.success(`Converted ${result.events.length} events (${format}) -> ${outputPath}`);
          } else {
            output.raw(out);
          }
          if (result.skippedRecords > 0) {
            output.warn(`Skipped ${result.skippedRecords} invalid or unresolvable trace records.`);
          }
          for (const warning of result.warnings) output.info(`Trace note: ${warning}`);
        },
      ),
    );

  traceCmd
    .command('show')
    .description('Show dynamic call trace data for the current project')
    .option('-w, --workload-id <id>', 'Filter by workload ID')
    .option('--static-missed', 'Show only static-missed calls')
    .action(
      asyncHandler(async (opts: { workloadId?: string; staticMissed?: boolean }) => {
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
              `count=${c.callCount}, workload=${c.workloadId}${missed}`,
            );
          }

          if (calls.length > 50) {
            output.info(`... and ${calls.length - 50} more. Use --workload-id to filter.`);
          }
        });
      }),
    );

  traceCmd
    .command('clear')
    .description('Clear dynamic call trace data')
    .option('-w, --workload-id <id>', 'Clear only this workload')
    .action(
      asyncHandler(async (opts: { workloadId?: string }) => {
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
      }),
    );

  return traceCmd;
}
