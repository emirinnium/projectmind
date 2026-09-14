import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from './types.js';
import {
  loadEmbeddingIndex,
  type IndexedSearchMetadata,
  type SemanticSearchScope,
  type SemanticSearchSource,
} from './semantic-search-index.js';
import type { EmbeddingIndexConfiguration } from '../../core/embeddings/index-configuration.js';
import { verifyProjectFreshness } from '../../core/proof/evidence.js';
import { searchSemantic } from '@/core/search/semantic.js';
import {
  featuresFromSearchResult,
  LearnedSearchReranker,
  type SearchRankerStatus,
} from '@/core/search/learned-reranker.js';
import {
  generateEmbedding,
  cosineSimilarity,
  getCurrentProvider,
  type EmbeddingProvider,
} from '@/parser/embeddings.js';

/**
 * semantic_search performs natural-language cosine search against the stored
 * file embeddings, or function/class embeddings when scope=symbol.
 *
 * Ranking is deliberately delegated to the pure core search function. This
 * wrapper adds project scoping, source locations, provider metadata, index
 * health, and explicit limitations so a consumer can judge the result.
 */

export interface SemanticSearchArgs {
  query: string;
  limit?: number;
  threshold?: number;
  scope?: SemanticSearchScope;
}

export interface SemanticSearchHit {
  filePath: string;
  score: number;
  kind?: 'file' | 'function' | 'class';
  symbolName?: string;
  startLine?: number | null;
  endLine?: number | null;
  indexEvidence?: IndexedSearchMetadata & { embeddingDimension: number };
}

export interface SemanticSearchResult {
  results: SemanticSearchHit[];
  query: {
    provider: EmbeddingProvider;
    dimension: number;
  };
  index: {
    projectId: number | null;
    scope: SemanticSearchScope;
    candidateFiles: number;
    indexedFiles: number;
    candidateItems: number;
    indexedItems: number;
    invalidEmbeddings: number;
    dimensions: number[];
    compatibleFiles: number;
    incompatibleFiles: number;
    compatibleItems: number;
    incompatibleItems: number;
    freshness: {
      status: 'verified' | 'partial' | 'stale' | 'unverified' | 'conflict';
      checkedAt: string;
      checkedFiles: number;
      freshFiles: number;
      staleFiles: number;
      unindexedFiles: number;
      missingFiles: number;
      unknownFiles: number;
    };
    configuration: EmbeddingIndexConfiguration | null;
  };
  evidence: {
    status: 'source-backed' | 'partial' | 'insufficient';
    method: 'cosine-similarity';
    source: SemanticSearchSource;
  };
  learning: SearchRankerStatus & {
    reranked: boolean;
  };
  limitations: string[];
}

export async function semanticSearchForTool(
  deps: McpDependencies,
  args: SemanticSearchArgs,
  embeddingGenerator: (text: string) => Promise<number[]> = generateEmbedding,
): Promise<SemanticSearchResult> {
  if (!deps.db) {
    throw new Error('semantic_search requires the project database, which is not initialized.');
  }

  const scope = args.scope ?? 'file';
  const index = loadEmbeddingIndex(deps.db, deps.projectRoot, scope);
  const queryEmbedding = await embeddingGenerator(args.query);
  const queryProvider = getCurrentProvider();
  const rawResults = await searchSemantic(
    args.query,
    async () => queryEmbedding,
    cosineSimilarity,
    index.embeddings,
    { limit: args.limit, threshold: args.threshold },
  );
  const results: SemanticSearchHit[] = rawResults.map((result) => {
    const metadata = index.metadata.get(result.filePath);
    return {
      filePath: metadata?.filePath ?? result.filePath,
      score: result.score,
      ...(metadata?.kind !== undefined && metadata.kind !== 'file'
        ? {
            kind: metadata.kind,
            symbolName: metadata.symbolName,
            startLine: metadata.startLine,
            endLine: metadata.endLine,
          }
        : {}),
      ...(metadata
        ? {
            indexEvidence: {
              ...metadata,
              embeddingDimension: index.embeddings.get(result.filePath)?.length ?? 0,
            },
          }
        : {}),
    };
  });

  const compatibleItems = [...index.embeddings.values()].filter(
    (embedding) => embedding.length === queryEmbedding.length,
  ).length;
  const incompatibleItems = index.indexedItems - compatibleItems;
  const compatibleFiles = new Set(
    [...index.metadata.entries()]
      .filter(([key]) => index.embeddings.get(key)?.length === queryEmbedding.length)
      .map(([, metadata]) => metadata.filePath),
  ).size;
  const incompatibleFiles = index.indexedFiles - compatibleFiles;
  const indexedPaths = [
    ...new Set([...index.metadata.values()].map((metadata) => metadata.filePath)),
  ];
  const freshness = await verifyProjectFreshness(deps.kg, deps.projectRoot, indexedPaths);

  const limitations: string[] = [
    'Semantic ranking is based on the indexed vectors; source freshness is verified separately and does not prove typecheck or runtime behavior.',
  ];
  if (index.projectId === null) {
    limitations.push(
      'No matching project record was found, so no stored embeddings were searched.',
    );
  }
  if (index.invalidEmbeddings > 0) {
    limitations.push(
      `${index.invalidEmbeddings} stored embedding(s) were unreadable or non-finite and were excluded.`,
    );
  }
  if (incompatibleItems > 0) {
    limitations.push(
      `${incompatibleItems} indexed ${scope === 'symbol' ? 'symbol' : 'file'} item(s) use a different vector dimension than the query and cannot be compared.`,
    );
  }
  if (index.dimensions.length > 1) {
    limitations.push(
      `The index contains ${index.dimensions.length} vector dimensions (${index.dimensions.join(', ')}); keep one provider/dimension per index for comparable results.`,
    );
  }
  if (index.configuration === null) {
    limitations.push(
      'The stored index has no valid provider manifest; vector compatibility is unknown. Re-scan the project before treating semantic ranking as source-backed.',
    );
  } else {
    if (index.configuration.activeProvider !== queryProvider) {
      limitations.push(
        `The index was generated with provider "${index.configuration.activeProvider}", but the current query uses "${queryProvider}"; comparable semantic space is not established.`,
      );
    }
    if (index.configuration.effectiveDimensions.length === 0) {
      limitations.push(
        `The index manifest requests dimension ${index.configuration.dimension} but has no observed vector dimension; provider compatibility is not established.`,
      );
    } else if (!index.configuration.effectiveDimensions.includes(queryEmbedding.length)) {
      limitations.push(
        `The index manifest records effective dimension(s) ${index.configuration.effectiveDimensions.join(', ')}, but the query returned dimension ${queryEmbedding.length}; provider compatibility is not established.`,
      );
    }
    if (index.configuration.requestedProvider !== index.configuration.activeProvider) {
      limitations.push(
        `The index requested provider "${index.configuration.requestedProvider}" but used fallback provider "${index.configuration.activeProvider}"; stronger provider quality must not be inferred.`,
      );
    }
  }

  if (freshness.status !== 'verified') {
    limitations.push(
      `Indexed source freshness is ${freshness.status}: ${freshness.freshFiles} fresh, ${freshness.staleFiles} stale, ${freshness.unindexedFiles} unindexed, ${freshness.missingFiles} missing, ${freshness.unknownFiles} unknown.`,
    );
  }

  const rerankerProjectId =
    index.projectId ??
    (typeof deps.kg.getCurrentProjectId === 'function' ? deps.kg.getCurrentProjectId() : null);
  const rerankCandidates = results.map((result, resultIndex) => ({
    path:
      scope === 'symbol'
        ? `${result.filePath}#${result.kind ?? 'symbol'}:${result.symbolName ?? resultIndex}`
        : result.filePath,
    baselineScore: result.score,
    features: featuresFromSearchResult({
      path: result.filePath,
      vector: result.score,
      freshness: freshness.status === 'verified' ? 1 : 0.5,
    }),
  }));
  const reranked = rerankerProjectId
    ? new LearnedSearchReranker(deps.db, rerankerProjectId, {
        projectRoot: deps.projectRoot,
      }).rerank(rerankCandidates)
    : {
        results: rerankCandidates.map((candidate) => ({
          ...candidate,
          learnedScore: candidate.baselineScore,
          score: candidate.baselineScore,
        })),
        status: {
          active: false,
          model: 'deterministic-online-pairwise-v1' as const,
          observations: 0,
          positiveObservations: 0,
          negativeObservations: 0,
          minimumObservations: 50,
          limitation: 'No persisted project was available for learned reranking.',
        },
      };
  const rerankedResults = reranked.results.map((ranked, index) => {
    const original = results.find((result, resultIndex) => {
      const key =
        scope === 'symbol'
          ? `${result.filePath}#${result.kind ?? 'symbol'}:${result.symbolName ?? resultIndex}`
          : result.filePath;
      return key === ranked.path;
    });
    if (!original) return results[index]!;
    return {
      ...original,
      score: ranked.score,
      rank: index + 1,
    };
  });
  if (!reranked.status.active) {
    limitations.push(reranked.status.limitation ?? 'Learned reranking is not active.');
  }

  const configurationUnverified =
    index.configuration === null ||
    index.configuration.activeProvider !== queryProvider ||
    index.configuration.effectiveDimensions.length === 0 ||
    (index.configuration.effectiveDimensions.length > 0 &&
      !index.configuration.effectiveDimensions.includes(queryEmbedding.length)) ||
    (index.configuration !== null &&
      index.configuration.requestedProvider !== index.configuration.activeProvider);

  const status =
    index.indexedItems === 0
      ? 'insufficient'
      : index.invalidEmbeddings > 0 ||
          incompatibleItems > 0 ||
          configurationUnverified ||
          freshness.status !== 'verified'
        ? 'partial'
        : 'source-backed';

  return {
    results: rerankedResults,
    query: {
      provider: queryProvider,
      dimension: queryEmbedding.length,
    },
    index: {
      projectId: index.projectId,
      scope,
      candidateFiles: index.candidateFiles,
      indexedFiles: index.indexedFiles,
      candidateItems: index.candidateItems,
      indexedItems: index.indexedItems,
      invalidEmbeddings: index.invalidEmbeddings,
      dimensions: index.dimensions,
      compatibleFiles,
      incompatibleFiles,
      compatibleItems,
      incompatibleItems,
      freshness: {
        status: freshness.status,
        checkedAt: freshness.checkedAt,
        checkedFiles: freshness.checkedFiles,
        freshFiles: freshness.freshFiles,
        staleFiles: freshness.staleFiles,
        unindexedFiles: freshness.unindexedFiles,
        missingFiles: freshness.missingFiles,
        unknownFiles: freshness.unknownFiles,
      },
      configuration: index.configuration,
    },
    evidence: {
      status,
      method: 'cosine-similarity',
      source: index.source,
    },
    learning: { ...reranked.status, reranked: reranked.status.active },
    limitations,
  };
}

export function registerSemanticSearchTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'semantic_search',
    {
      title: 'Semantic File and Symbol Search',
      description:
        "Natural-language semantic search over the project's stored embeddings.\n" +
        'Use scope=file for whole-file retrieval or scope=symbol to rank indexed functions/classes with source locations. ' +
        'The response includes provider, index dimensions, source hashes, verified source freshness, and explicit limitations; freshness does not prove typecheck or runtime behavior.',
      inputSchema: {
        query: z.string().describe('Natural-language query to match against stored embeddings'),
        scope: z
          .enum(['file', 'symbol'])
          .default('file')
          .describe('Search whole files or indexed functions/classes'),
        limit: z.number().int().min(1).max(50).default(5).describe('Maximum number of results'),
        threshold: z
          .number()
          .min(0)
          .max(1)
          .default(0.7)
          .describe('Minimum cosine similarity (0..1) for a result'),
      },
    },
    async (args) => {
      try {
        const result = await semanticSearchForTool(deps, {
          query: args.query,
          scope: args.scope,
          limit: args.limit,
          threshold: args.threshold,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: false,
                error: message,
                results: [],
                limitations: [
                  'Semantic search did not complete; no ranking should be inferred from this response.',
                ],
              }),
            },
          ],
        };
      }
    },
  );
}
