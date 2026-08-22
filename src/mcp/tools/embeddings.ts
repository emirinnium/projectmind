import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from './types.js';
import { trackAgentAccess } from './types.js';
import { initEmbeddingProvider, getCurrentProvider, generateEmbedding } from '@/parser/embeddings.js';

export function registerEmbeddingTools(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'init_embedding_provider',
    {
      title: 'Init Embedding Provider',
      description: 'Initialize the embedding provider for code/text similarity. Supports simple, unixcoder, and codebert providers. UniXcoder/CodeBERT require onnxruntime-node and model files.',
      inputSchema: {
        provider: z.enum(['simple', 'unixcoder', 'codebert']).default('simple').describe('Embedding provider to use'),
        modelPath: z.string().optional().describe('Path to ONNX model file (for unixcoder/codebert)'),
        dimension: z.number().default(768).describe('Embedding dimension'),
      },
    },
    async (args) => {
      try {
        if (deps.agentName) {
          trackAgentAccess(deps.kg, deps.agentName, 'embedding-init');
        }

        await initEmbeddingProvider({
          provider: args.provider,
          modelPath: args.modelPath,
          dimension: args.dimension,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                provider: getCurrentProvider(),
                dimension: args.dimension,
              }, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : String(error),
              }, null, 2),
            },
          ],
        };
      }
    }
  );

  server.registerTool(
    'generate_embedding',
    {
      title: 'Generate Embedding',
      description: 'Generate an embedding vector for the given text or code snippet using the current embedding provider.',
      inputSchema: {
        text: z.string().describe('Text or code snippet to embed'),
        dimension: z.number().default(768).describe('Embedding dimension'),
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
              text: JSON.stringify({
                success: true,
                provider: getCurrentProvider(),
                dimension: embedding.length,
                embedding,
              }, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : String(error),
              }, null, 2),
            },
          ],
        };
      }
    }
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
              text: JSON.stringify({
                success: true,
                provider,
              }, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : String(error),
              }, null, 2),
            },
          ],
        };
      }
    }
  );
}
