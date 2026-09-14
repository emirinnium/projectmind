import { logger } from '../../dist/utils/logger.js';
import { runMcpBenchmark } from './benchmark-mcp.mjs';
import { withService } from '../../dist/cli/utils/services.js';
function parseArgs(argv) {
  let root;
  let timeout;
  let profile = 'core';
  let tokenizer = 'heuristic';
  let tokenizerModel;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--root') root = argv[++i];
    else if (flag === '--timeout') timeout = Number(argv[++i]);
    else if (flag === '--profile') {
      const value = argv[++i];
      if (!['core', 'review', 'security', 'maintenance', 'full'].includes(value)) {
        throw new Error(`Invalid isolated benchmark profile: ${value}`);
      }
      profile = value;
    } else if (flag === '--tokenizer') {
      tokenizer = argv[++i];
      if (tokenizer !== 'heuristic' && tokenizer !== 'transformers') {
        throw new Error(`Invalid isolated benchmark tokenizer: ${tokenizer}`);
      }
    } else if (flag === '--tokenizer-model') tokenizerModel = argv[++i];
    else throw new Error(`Unknown isolated benchmark worker argument: ${flag}`);
  }
  if (!root) throw new Error('Isolated benchmark worker requires --root.');
  if (!Number.isFinite(timeout) || timeout === undefined) {
    throw new Error('Isolated benchmark worker requires a finite --timeout.');
  }
  return { root, timeout, profile, tokenizer, tokenizerModel };
}
async function main() {
  const args = parseArgs(process.argv.slice(2));
  logger.setMachineMode(true);
  const result = await withService(
    ['scale', 'debt', 'coherence'],
    async (ctx, services) =>
      runMcpBenchmark(
        {
          projectRoot: args.root,
          kg: ctx.kg,
          db: ctx.db,
          scale: services.scale,
          debt: services.debt,
          coherence: services.coherence,
        },
        {
          invocationTimeoutMs: args.timeout,
          isolated: false,
          profile: args.profile,
          tokenizerMode: args.tokenizer,
          tokenizerModel: args.tokenizerModel,
        },
      ),
    args.root,
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
main().catch((error) => {
  logger.setMachineMode(true);
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
