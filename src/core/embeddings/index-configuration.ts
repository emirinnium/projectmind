export type EmbeddingIndexProvider =
  'simple' | 'openai' | 'transformers' | 'unixcoder' | 'codebert';

/** Settings key prefix for the provider contract attached to each project index. */
export const EMBEDDING_INDEX_CONFIG_PREFIX = 'embedding_index_config:';

/**
 * The runtime contract that produced the persisted vectors for one project.
 *
 * Vector dimensions alone are not enough to establish compatibility: two
 * providers can emit vectors of the same length while encoding different
 * semantic spaces. The provider/model fields therefore travel with the
 * index and are reported whenever a consumer loads it.
 */
export interface EmbeddingIndexConfiguration {
  requestedProvider: EmbeddingIndexProvider;
  activeProvider: EmbeddingIndexProvider;
  /** Dimension requested from the configured provider. */
  dimension: number;
  /** Dimensions actually observed in persisted vectors (legacy manifests may omit this). */
  effectiveDimensions: number[];
  openaiModel: string;
  transformersModel: string;
  unixcoderModelPath: string;
  codebertModelPath: string;
}

export function embeddingIndexConfigKey(projectId: number): string {
  return `${EMBEDDING_INDEX_CONFIG_PREFIX}${projectId}`;
}

export function serializeEmbeddingIndexConfiguration(
  configuration: EmbeddingIndexConfiguration,
): string {
  return JSON.stringify(configuration);
}

/**
 * Return the stable configuration fingerprint used to decide whether an
 * incremental scan must rebuild vectors. Observed dimensions are deliberately
 * excluded: they are a result of indexing, not an input to the scan plan.
 */
export function embeddingIndexConfigurationFingerprint(
  configuration: EmbeddingIndexConfiguration,
): string {
  const { effectiveDimensions: _effectiveDimensions, ...requestedConfiguration } = configuration;
  return JSON.stringify(requestedConfiguration);
}

/**
 * Parse a stored manifest defensively. A malformed or legacy value is treated
 * as unknown so semantic retrieval can report the limitation instead of
 * trusting an unverified provider contract.
 */
export function parseEmbeddingIndexConfiguration(
  value: string | null | undefined,
): EmbeddingIndexConfiguration | null {
  if (!value) return null;

  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) return null;

    const requestedProvider = parsed.requestedProvider;
    const activeProvider = parsed.activeProvider;
    const dimension = parsed.dimension;
    const effectiveDimensions = parsed.effectiveDimensions;
    const openaiModel = parsed.openaiModel;
    const transformersModel = parsed.transformersModel;
    const unixcoderModelPath = parsed.unixcoderModelPath;
    const codebertModelPath = parsed.codebertModelPath;

    if (
      !isEmbeddingIndexProvider(requestedProvider) ||
      !isEmbeddingIndexProvider(activeProvider) ||
      typeof dimension !== 'number' ||
      !Number.isSafeInteger(dimension) ||
      dimension <= 0 ||
      (effectiveDimensions !== undefined &&
        (!Array.isArray(effectiveDimensions) ||
          effectiveDimensions.some(
            (item) => typeof item !== 'number' || !Number.isSafeInteger(item) || item <= 0,
          ))) ||
      typeof openaiModel !== 'string' ||
      typeof transformersModel !== 'string' ||
      typeof unixcoderModelPath !== 'string' ||
      typeof codebertModelPath !== 'string'
    ) {
      return null;
    }

    return {
      requestedProvider,
      activeProvider,
      dimension,
      effectiveDimensions:
        effectiveDimensions === undefined ? [] : ([...effectiveDimensions] as number[]),
      openaiModel,
      transformersModel,
      unixcoderModelPath,
      codebertModelPath,
    };
  } catch {
    return null;
  }
}

function isEmbeddingIndexProvider(value: unknown): value is EmbeddingIndexProvider {
  return (
    value === 'simple' ||
    value === 'openai' ||
    value === 'transformers' ||
    value === 'unixcoder' ||
    value === 'codebert'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
