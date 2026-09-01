import { Command } from 'commander';
import { asyncHandler, output, loadConfig, join } from '@/cli/utils/shared.js';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';

function addDirOption(cmd: Command): Command {
  return cmd.option('-d, --dir <path>', 'ADR directory', '.projectmind/adrs');
}

export function createAdrCommand(): Command {
  const adrCmd = new Command('adr').description('Architecture Decision Records management');

  addDirOption(
    adrCmd
      .command('new <title>')
      .description('Create a new ADR')
      .option('-s, --status <status>', 'Status: proposed|accepted|rejected|superseded', 'proposed')
      .option('-c, --context <text>', 'Context for the decision')
      .option('--supersedes <ids>', 'Comma-separated ADR IDs this supersedes')
      .action(
        asyncHandler(
          async (
            title: string,
            opts: { status: string; context: string; supersedes: string; dir: string },
          ) => {
            const config = loadConfig();
            const adrDir = join(config.projectRoot, opts.dir);

            if (!existsSync(adrDir)) {
              mkdirSync(adrDir, { recursive: true });
            }

            const existing = readdirSync(adrDir).filter((f) => f.endsWith('.md')).length;
            const id = String(existing + 1).padStart(4, '0');
            const filename = `${id}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`;
            const filepath = join(adrDir, filename);

            const template = `# ${id}: ${title}

**Status:** ${opts.status}
**Date:** ${new Date().toISOString().split('T')[0]}
${opts.supersedes ? `**Supersedes:** ${opts.supersedes}` : ''}

## Context
${opts.context || 'Describe the context and problem statement here.'}

## Decision
Describe the decision made.

## Consequences
### Positive
- 

### Negative
- 

### Neutral
- 

## Alternatives Considered
- 

## References
- 
`;

            writeFileSync(filepath, template);
            output.success(`Created ADR: ${filename}`);
            output.info(`Edit ${filepath} to complete the record.`);
          },
        ),
      ),
  );

  addDirOption(
    adrCmd
      .command('list')
      .description('List all ADRs')
      .option('--status <status>', 'Filter by status')
      .option('--format <fmt>', 'Output: text|json|table', 'table')
      .action(
        asyncHandler(async (opts: { status: string; format: string; dir: string }) => {
          const config = loadConfig();
          const adrDir = join(config.projectRoot, opts.dir);

          if (!existsSync(adrDir)) {
            output.warn('No ADR directory found. Run "projectmind adr new" first.');
            return;
          }

          const files = readdirSync(adrDir)
            .filter((f) => f.endsWith('.md'))
            .sort();

          const adrs = files.map((f) => {
            const content = readFileSync(join(adrDir, f), 'utf-8');
            const statusMatch = content.match(/\*\*Status:\*\*\s*(.+)/);
            const dateMatch = content.match(/\*\*Date:\*\*\s*(.+)/);
            const titleMatch = content.match(/^#\s+(.+)$/m);
            return {
              id: f.split('-')[0],
              filename: f,
              title: titleMatch ? titleMatch[1].split(': ').slice(1).join(': ') : f,
              status: statusMatch ? statusMatch[1].trim() : 'unknown',
              date: dateMatch ? dateMatch[1].trim() : 'unknown',
            };
          });

          const filtered = opts.status ? adrs.filter((a) => a.status === opts.status) : adrs;

          if (opts.format === 'json') {
            output.info(JSON.stringify(filtered, null, 2));
            return;
          }

          output.section(`ADRs (${filtered.length})`);
          output.info('ID  | Status       | Date       | Title');
          output.info('----|--------------|------------|------');
          for (const adr of filtered) {
            output.info(
              `${adr.id.padEnd(3)} | ${adr.status.padEnd(12)} | ${adr.date.padEnd(10)} | ${adr.title}`,
            );
          }
        }),
      ),
  );

  addDirOption(
    adrCmd
      .command('index')
      .description('Generate ADR index (Markdown)')
      .option('-o, --output <file>', 'Output file', 'ADR_INDEX.md')
      .action(
        asyncHandler(async (opts: { output: string; dir: string }) => {
          const config = loadConfig();
          const adrDir = join(config.projectRoot, opts.dir);
          const outputFile = join(config.projectRoot, opts.output);

          if (!existsSync(adrDir)) {
            output.warn('No ADR directory found.');
            return;
          }

          const files = readdirSync(adrDir)
            .filter((f) => f.endsWith('.md'))
            .sort();

          const lines = [
            '# Architecture Decision Records Index',
            '',
            '| ID | Title | Status | Date |',
            '|----|-------|--------|------|',
          ];

          for (const f of files) {
            const content = readFileSync(join(adrDir, f), 'utf-8');
            const statusMatch = content.match(/\*\*Status:\*\*\s*(.+)/);
            const dateMatch = content.match(/\*\*Date:\*\*\s*(.+)/);
            const titleMatch = content.match(/^#\s+(.+)$/m);
            const id = f.split('-')[0];
            const title = titleMatch ? titleMatch[1].split(': ').slice(1).join(': ') : f;
            const status = statusMatch ? statusMatch[1].trim() : 'unknown';
            const date = dateMatch ? dateMatch[1].trim() : 'unknown';
            lines.push(`| ${id} | [${title}](${f}) | ${status} | ${date} |`);
          }

          writeFileSync(outputFile, lines.join('\n'));
          output.success(`ADR index written to ${opts.output}`);
        }),
      ),
  );

  return adrCmd;
}
