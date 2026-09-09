import { Command } from 'commander';
import { readSourceRange } from '@/core/retrieval/byte-range.js';
import { asyncHandler, loadConfig, output } from '@/cli/utils/shared.js';

export function createRangeCommand(): Command {
  return new Command('range')
    .description('Read a bounded UTF-8 source byte range')
    .argument('<file>', 'Project-relative source file')
    .requiredOption('--start <byte>', 'Start byte offset')
    .requiredOption('--end <byte>', 'Exclusive end byte offset')
    .option('--max-bytes <n>', 'Maximum returned bytes', '65536')
    .option('--format <format>', 'Output format: text|json', 'text')
    .action(
      asyncHandler(
        async (
          file: string,
          opts: { start: string; end: string; maxBytes: string; format: string },
        ) => {
          if (!['text', 'json'].includes(opts.format))
            throw new Error('--format must be text or json.');
          const start = Number.parseInt(opts.start, 10);
          const end = Number.parseInt(opts.end, 10);
          const maxBytes = Number.parseInt(opts.maxBytes, 10);
          if (![start, end, maxBytes].every(Number.isSafeInteger))
            throw new Error('Byte offsets and --max-bytes must be integers.');
          const result = readSourceRange(file, loadConfig().projectRoot, start, end, maxBytes);
          if (opts.format === 'json') {
            output.json(result);
            return;
          }
          output.section(`${result.filePath}:${result.lineStart}-${result.lineEnd}`);
          output.kv('Bytes', `${result.startByte}-${result.endByte}`);
          output.kv('Source hash', result.sourceHash);
          output.kv('Truncated', result.truncated ? 'yes' : 'no');
          output.raw(result.content);
        },
      ),
    );
}
