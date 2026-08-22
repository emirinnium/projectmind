import { Command } from 'commander';
import { withService, asyncHandler, output } from '@/cli/utils/shared.js';

type DataFlow = {
  id: number;
  fromResource: { id: number; qualifiedName: string; kind: string; identity: string };
  toResource: { id: number; qualifiedName: string; kind: string; identity: string };
  kind: string;
  via: string | null;
  sourceFunctionName: string | null;
  targetFunctionName: string | null;
};

export function createDataFlowCommand(): Command {
  const dataFlowCmd = new Command('data-flow')
    .description('Data-flow and taint analysis: track resources, flows, and dependencies');

  dataFlowCmd
    .command('record')
    .description('Record a data-flow edge between resources')
    .requiredOption('--from <qualifiedName>', 'Source resource qualified name')
    .requiredOption('--from-kind <kind>', 'Source resource kind: FILE|NETWORK|DATABASE|ENV|STDIN|STDOUT|STDERR|SOCKET')
    .requiredOption('--from-identity <identity>', 'Source resource identity (path, URL, etc.)')
    .requiredOption('--to <qualifiedName>', 'Target resource qualified name')
    .requiredOption('--to-kind <kind>', 'Target resource kind: FILE|NETWORK|DATABASE|ENV|STDIN|STDOUT|STDERR|SOCKET')
    .requiredOption('--to-identity <identity>', 'Target resource identity')
    .requiredOption('--kind <kind>', 'Flow kind: resource|arg|return')
    .option('--via <via>', 'Optional intermediate (function name, variable)')
    .option('--source-function <name>', 'Source function name')
    .option('--target-function <name>', 'Target function name')
    .action(asyncHandler(async (opts: {
      from: string;
      fromKind: string;
      fromIdentity: string;
      to: string;
      toKind: string;
      toIdentity: string;
      kind: 'resource' | 'arg' | 'return';
      via?: string;
      sourceFunction?: string;
      targetFunction?: string;
    }) => {
      await withService(['scale'], async (ctx) => {
        const kg = ctx.kg;

        const kind = opts.kind as DataFlow['fromResource']['kind'];
        if (!['resource', 'arg', 'return'].includes(kind)) {
          output.error(`Invalid kind: ${kind}. Must be one of: resource, arg, return`);
          return;
        }

        const result = kg.recordDataFlow({
          fromResourceQualifiedName: opts.from,
          fromResourceKind: opts.fromKind as 'FILE' | 'NETWORK' | 'DATABASE' | 'ENV' | 'STDIN' | 'STDOUT' | 'STDERR' | 'SOCKET',
          fromResourceIdentity: opts.fromIdentity,
          toResourceQualifiedName: opts.to,
          toResourceKind: opts.toKind as 'FILE' | 'NETWORK' | 'DATABASE' | 'ENV' | 'STDIN' | 'STDOUT' | 'STDERR' | 'SOCKET',
          toResourceIdentity: opts.toIdentity,
          kind: kind as 'resource' | 'arg' | 'return',
          via: opts.via,
          sourceFunctionName: opts.sourceFunction,
          targetFunctionName: opts.targetFunction,
        });

        output.success(`Recorded data flow #${result.id}`);
        output.kv('From', `${result.fromResource.qualifiedName} (${result.fromResource.kind})`);
        output.kv('To', `${result.toResource.qualifiedName} (${result.toResource.kind})`);
      });
    }));

  dataFlowCmd
    .command('list')
    .description('List all data flows for the current project')
    .action(asyncHandler(async () => {
      await withService(['scale'], async (ctx) => {
        const kg = ctx.kg;
        const flows = kg.getDataFlows();

        output.section(`Data Flows (${flows.length})`);

        if (flows.length === 0) {
          output.warn('No data flows recorded. Use `data-flow record` to add edges.');
          return;
        }

        for (const flow of flows) {
          const via = flow.via ? ` via ${flow.via}` : '';
          const srcFn = flow.sourceFunctionName ? ` [${flow.sourceFunctionName}]` : '';
          const tgtFn = flow.targetFunctionName ? ` [${flow.targetFunctionName}]` : '';
          output.kv(`#${flow.id} ${flow.kind}`, `${flow.fromResource.qualifiedName}${srcFn} -> ${flow.toResource.qualifiedName}${tgtFn}${via}`);
        }
      });
    }));

  dataFlowCmd
    .command('resource <qualifiedName>')
    .description('Show all flows for a specific resource')
    .action(asyncHandler(async (qualifiedName: string) => {
      await withService(['scale'], async (ctx) => {
        const kg = ctx.kg;
        const flows = kg.getResourceFlows(qualifiedName);

        output.section(`Flows for "${qualifiedName}" (${flows.length})`);

        if (flows.length === 0) {
          output.warn('No flows found for this resource.');
          return;
        }

        for (const flow of flows) {
          const arrow = flow.direction === 'from' ? '→' : '←';
          output.kv(`#${flow.id} (${flow.direction})`, `${arrow} ${flow.resource.qualifiedName} (${flow.kind})${flow.via ? ` via ${flow.via}` : ''}`);
        }
      });
    }));

  dataFlowCmd
    .command('clear')
    .description('Clear all data flows for the current project')
    .action(asyncHandler(async () => {
      await withService(['scale'], async (ctx) => {
        const kg = ctx.kg;
        const cleared = kg.clearDataFlows();
        output.success(`Cleared ${cleared} data flows`);
      });
    }));

  return dataFlowCmd;
}
