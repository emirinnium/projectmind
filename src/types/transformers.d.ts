declare module '@huggingface/transformers' {
  export interface FeatureExtractionResult {
    data: Float32Array;
  }

  export interface FeatureExtractionPipeline {
    (
      text: string,
      options?: { pooling?: string; normalize?: boolean },
    ): Promise<FeatureExtractionResult>;
  }

  export function pipeline(task: string, model: string): Promise<FeatureExtractionPipeline>;

  export interface TokenizerTensor {
    data: ArrayLike<number | bigint>;
  }

  export interface TokenizerOutput {
    input_ids?: TokenizerTensor;
    attention_mask?: TokenizerTensor;
  }

  export interface AutoTokenizerInstance {
    (
      text: string,
      options?: { padding?: 'max_length'; truncation?: boolean; max_length?: number },
    ): Promise<TokenizerOutput> | TokenizerOutput;
  }

  export const AutoTokenizer: {
    from_pretrained(model: string): Promise<AutoTokenizerInstance>;
  };
}
