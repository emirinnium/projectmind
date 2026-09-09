import { Command } from 'commander';
import { withService, asyncHandler, output } from '@/cli/utils/shared.js';
import { readFileSync, existsSync } from 'node:fs';
import { TaintAnalyzer } from '@/parser/taint-analyzer.js';
import { detectLanguageFromPath } from '@/parser/language-service.js';
import { loadConfig } from '@/cli/utils/shared.js';
import { confineToProject } from '@/mcp/tools/_shared.js';

export function createTaintCommand(): Command {
  const taintCmd = new Command('taint').description(
    'Taint analysis: detect data flows from sources to sinks',
  );

  taintCmd.action(() => {
    taintCmd.outputHelp();
  });

  taintCmd
    .command('analyze <path>')
    .description('Analyze a file for taint flows')
    .action(
      asyncHandler(async (path: string) => {
        const absolutePath = confineToProject(path, loadConfig().projectRoot);
        await withService(['scale'], async (ctx) => {
          const kg = ctx.kg;
          const analyzer = new TaintAnalyzer(kg);

          if (!existsSync(absolutePath)) {
            output.error(`File not found: ${absolutePath}`);
            return;
          }

          const content = readFileSync(absolutePath, 'utf-8');
          const lang = detectLanguageFromPath(absolutePath);
          if (!lang) {
            output.error('Taint analysis supports only TypeScript and JavaScript files.');
            return;
          }

          const flows = analyzer.analyzeSource(absolutePath, content, lang);

          output.section(`Taint Analysis: ${path} (${flows.length} flows)`);

          if (flows.length === 0) {
            output.warn('No taint flows detected.');
            return;
          }

          for (const flow of flows) {
            output.kv(
              `${flow.source.qualifiedName} → ${flow.sink.qualifiedName}`,
              `kind=${flow.source.kind}${flow.viaFunction ? ` via=${flow.viaFunction}` : ''}`,
            );
          }

          const recorded = analyzer.recordFlows(absolutePath, content, lang);
          output.success(`Recorded ${recorded} flows to knowledge graph`);
        });
      }),
    );

  taintCmd
    .command('record <path>')
    .description('Analyze a file and record flows to the knowledge graph')
    .action(
      asyncHandler(async (path: string) => {
        const absolutePath = confineToProject(path, loadConfig().projectRoot);
        await withService(['scale'], async (ctx) => {
          const kg = ctx.kg;
          const analyzer = new TaintAnalyzer(kg);

          if (!existsSync(absolutePath)) {
            output.error(`File not found: ${absolutePath}`);
            return;
          }

          const content = readFileSync(absolutePath, 'utf-8');
          const lang = detectLanguageFromPath(absolutePath);
          if (!lang) {
            output.error('Taint analysis supports only TypeScript and JavaScript files.');
            return;
          }

          const recorded = analyzer.recordFlows(absolutePath, content, lang);
          output.success(`Recorded ${recorded} taint flows from ${absolutePath}`);
        });
      }),
    );

  return taintCmd;
}
