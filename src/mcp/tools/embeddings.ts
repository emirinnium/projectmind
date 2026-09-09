import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from './types.js';
import { trackAgentAccess } from './types.js';
import { confineToProject } from './_shared.js';
import {
  initEmbeddingProvider,
  getCurrentProvider,
  generateEmbedding,
} from '@/parser/embeddings.js';

export function registerEmbeddingTools(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'init_embedding_provider',
    {
      title: 'Init Embedding Provider',
      description:
        'Initialize the embedding provider for code/text similarity. Supports simple, openai, transformers, unixcoder, and codebert. Optional providers may require credentials, model downloads, or onnxruntime-node; unavailable providers return an explicit fallback explanation.',
      inputSchema: {
        provider: z
          .enum(['simple', 'openai', 'transformers', 'unixcoder', 'codebert'])
          .default('simple')
          .describe('Embedding provider to use'),
        modelPath: z
          .string()
          .optional()
          .describe('Path to ONNX model file (for unixcoder/codebert)'),
        openaiApiKey: z
          .string()
          .min(1)
          .optional()
          .describe('Optional OpenAI API key; OPENAI_API_KEY is used when omitted'),
        openaiModel: z.string().min(1).optional().describe('Optional OpenAI embedding model'),
        transformersModel: z
          .string()
          .min(1)
          .optional()
          .describe('Optional Transformers.js model identifier'),
        dimension: z.number().int().min(1).max(8192).default(768).describe('Embedding dimension'),
      },
    },
    async (args) => {
      try {
        if (deps.agentName) {
          trackAgentAccess(deps.kg, deps.agentName, 'embedding-init');
        }

        const modelPath =
          args.modelPath !== undefined
            ? confineToProject(args.modelPath, deps.projectRoot)
            : undefined;

        const initResult = await initEmbeddingProvider({
          provider: args.provider,
          modelPath,
          dimension: args.dimension,
          openaiApiKey: args.openaiApiKey,
          openaiModel: args.openaiModel,
          transformersModel: args.transformersModel,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  ...initResult,
                  dimension: args.dimension,
                  dimensionSemantics:
                    'This is the requested generation dimension. The actual vector dimension is confirmed by generate_embedding.',
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: false,
                  error: error instanceof Error ? error.message : String(error),
                },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    'generate_embedding',
    {
      title: 'Generate Embedding',
      description:
        'Generate an embedding vector for the given text or code snippet using the current embedding provider.',
      inputSchema: {
        text: z
          .string()
          .max(200_000)
          .describe('Text or code snippet to embed (maximum 200,000 characters)'),
        dimension: z.number().int().min(1).max(8192).default(768).describe('Embedding dimension'),
      },
    },
    async (args) => {
      try {
        if (deps.agentName) {
          trackAgentAccess(deps.kg, deps.agentName, 'embedding-generate');
        }

        const embedding = await generateEmbedding(args.text, args.dimension);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  provider: getCurrentProvider(),
                  dimension: embedding.length,
                  embedding,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: false,
                  error: error instanceof Error ? error.message : String(error),
                },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    'get_embedding_provider',
    {
      title: 'Get Embedding Provider',
      description: 'Get the current embedding provider and its configuration.',
      inputSchema: {},
    },
    async () => {
      try {
        if (deps.agentName) {
          trackAgentAccess(deps.kg, deps.agentName, 'embedding-get-provider');
        }

        const provider = getCurrentProvider();

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  provider,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: false,
                  error: error instanceof Error ? error.message : String(error),
                },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );
}
