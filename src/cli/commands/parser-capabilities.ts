import { Command } from 'commander';
import { asyncHandler, output } from '@/cli/utils/shared.js';
import { listParserCapabilities } from '../../parser/parser-registry.js';

/** Reports the parser registry as a stable capability contract for agents and CI. */
export function createParserCapabilitiesCommand(): Command {
  return new Command('parser-capabilities')
    .description('List registered languages, extensions, and parser capabilities')
    .option('--format <fmt>', 'Output: text|json', 'text')
    .action(
      asyncHandler(async (opts: { format: string }) => {
        const result = { protocolVersion: 1, parsers: listParserCapabilities() };
        if (opts.format === 'json') {
          output.json(result);
          return;
        }
        output.section('Parser Capabilities');
        for (const parser of result.parsers) {
          output.kv(
            parser.language,
            `${parser.extensions.join(', ')} | ${parser.capabilities.join(', ')}`,
          );
        }
      }),
    );
}
