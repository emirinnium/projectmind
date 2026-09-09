import { describe, expect, it } from 'vitest';
import {
  embeddingIndexConfigKey,
  parseEmbeddingIndexConfiguration,
  serializeEmbeddingIndexConfiguration,
  type EmbeddingIndexConfiguration,
} from '../../../src/core/embeddings/index-configuration.js';

const configuration: EmbeddingIndexConfiguration = {
  requestedProvider: 'openai',
  activeProvider: 'simple',
  dimension: 768,
  effectiveDimensions: [768],
  openaiModel: 'text-embedding-3-small',
  transformersModel: 'Xenova/all-MiniLM-L6-v2',
  unixcoderModelPath: 'models/unixcoder-base.onnx',
  codebertModelPath: 'models/codebert-base.onnx',
};

describe('embedding index configuration contract', () => {
  it('serializes and parses the provider/model/dimension contract', () => {
    const encoded = serializeEmbeddingIndexConfiguration(configuration);

    expect(parseEmbeddingIndexConfiguration(encoded)).toEqual(configuration);
    expect(embeddingIndexConfigKey(7)).toBe('embedding_index_config:7');
  });

  it.each([
    undefined,
    '',
    'not-json',
    JSON.stringify({ ...configuration, activeProvider: 'unknown' }),
    JSON.stringify({ ...configuration, dimension: 0 }),
    JSON.stringify({ ...configuration, dimension: 3.5 }),
    JSON.stringify({ ...configuration, openaiModel: null }),
  ])('rejects an invalid or incomplete manifest: %s', (value) => {
    expect(parseEmbeddingIndexConfiguration(value)).toBeNull();
  });

  it('does not accept arrays as manifests', () => {
    expect(parseEmbeddingIndexConfiguration(JSON.stringify([configuration]))).toBeNull();
  });
});
