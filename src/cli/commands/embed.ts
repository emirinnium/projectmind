import { Command } from 'commander';
import { withService, asyncHandler, output } from '@/cli/utils/shared.js';
import { initEmbeddingProvider, getCurrentProvider, generateEmbedding } from '@/parser/embeddings.js';

export function createEmbedCommand(): Command {
  const embedCmd = new Command('embed')
    .description('Embedding generation and code similarity search');

  embedCmd
    .command('init')
    .description('Initialize the embedding provider')
    .option('-p, --provider <provider>', 'Embedding provider: simple|openai|transformers|unixcoder|codebert', 'simple')
    .option('-m, --model-path <path>', 'Path to ONNX model file')
    .option('-d, --dimension <n>', 'Embedding dimension', '768')
    .option('--openai-api-key <key>', 'OpenAI API key (or set OPENAI_API_KEY env var)')
    .option('--openai-model <model>', 'OpenAI model name', 'text-embedding-3-small')
    .option('--transformers-model <model>', 'Transformers.js model name', 'Xenova/all-MiniLM-L6-v2')
    .action(asyncHandler(async (opts: { provider: string; modelPath?: string; dimension: string; openaiApiKey?: string; openaiModel?: string; transformersModel?: string }) => {
      await withService(['scale'], async (_ctx) => {
        await initEmbeddingProvider({
          provider: opts.provider as 'simple' | 'openai' | 'transformers' | 'unixcoder' | 'codebert',
          modelPath: opts.modelPath,
          dimension: parseInt(opts.dimension, 10),
          openaiApiKey: opts.openaiApiKey,
          openaiModel: opts.openaiModel,
          transformersModel: opts.transformersModel,
        });

        output.success(`Embedding provider initialized: ${getCurrentProvider()}`);
      });
    }));

  embedCmd
    .command('generate')
    .description('Generate embedding for a text or code snippet')
    .requiredOption('-t, --text <text>', 'Text or code to embed')
    .option('-d, --dimension <n>', 'Embedding dimension', '768')
    .option('-p, --provider <provider>', 'Embedding provider override')
    .action(asyncHandler(async (opts: { text: string; dimension: string; provider?: string }) => {
      await withService(['scale'], async () => {
        // Initialize provider only if override specified or not yet initialized
        const currentProvider = getCurrentProvider();
        if (opts.provider || !currentProvider || currentProvider === 'simple') {
          const { loadConfig } = await import('@/utils/config.js');
          const config = loadConfig();
          await initEmbeddingProvider({
            provider: (opts.provider as 'simple' | 'openai' | 'transformers' | 'unixcoder' | 'codebert') || config.embeddings.provider,
            openaiApiKey: config.embeddings.openaiApiKey,
            openaiModel: config.embeddings.openaiModel,
            transformersModel: config.embeddings.transformersModel,
          });
        }

        const embedding = await generateEmbedding(opts.text, parseInt(opts.dimension, 10));

        output.section(`Embedding (${embedding.length} dims, provider=${getCurrentProvider()})`);
        output.kv('Preview', JSON.stringify(embedding.slice(0, 10)) + '...');
        output.info('Full embedding vector generated successfully.');
      });
    }));

  embedCmd
    .command('similar')
    .description('Find similar code snippets in the codebase')
    .requiredOption('-t, --text <text>', 'Query text or code')
    .option('-d, --dimension <n>', 'Embedding dimension', '768')
    .option('-k, --top-k <n>', 'Number of results', '10')
    .action(asyncHandler(async (opts: { text: string; dimension: string; topK: string }) => {
      await withService(['scale'], async (ctx) => {
        const kg = ctx.kg;
        const queryEmbedding = await generateEmbedding(opts.text, parseInt(opts.dimension, 10));
        const results = kg.findSimilarFiles(queryEmbedding, 0.0, parseInt(opts.topK, 10));

        output.section(`Similarity Search (${results.length} results)`);

        if (results.length === 0) {
          output.warn('No similar code found.');
          return;
        }

        for (const r of results.slice(0, 10)) {
          output.kv(`${r.path}:${r.language || '?'}`, `score=${r.cognitiveLoad || 0}`);
        }

        if (results.length > 10) {
          output.info(`... and ${results.length - 10} more results. Use --top-k to see more.`);
        }
      });
    }));

  embedCmd
    .command('provider')
    .description('Show the current embedding provider')
    .action(asyncHandler(async () => {
      await withService(['scale'], async () => {
        output.kv('Provider', getCurrentProvider());
      });
    }));

  return embedCmd;
}
