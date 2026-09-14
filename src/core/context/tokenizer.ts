import { readFile } from 'node:fs/promises';

export type ContextTokenizerMode = 'heuristic' | 'transformers';

export interface ContextTokenCounter {
  readonly mode: ContextTokenizerMode;
  readonly model: string | null;
  readonly limitations: readonly string[];
  count(text: string): Promise<number>;
}

interface TokenTensor {
  data?: ArrayLike<number>;
}

interface TransformerTokenizerOutput {
  input_ids?: TokenTensor;
}

interface TransformerTokenizer {
  (text: string): Promise<TransformerTokenizerOutput> | TransformerTokenizerOutput;
}

interface TransformerTokenizerModule {
  AutoTokenizer: {
    from_pretrained(model: string): Promise<TransformerTokenizer>;
  };
}

/** Keep the historical local estimate stable for the default/offline path. */
export function estimateContextTokens(text: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(text, 'utf8') / 4));
}

function countTransformerOutput(output: TransformerTokenizerOutput): number {
  const length = output.input_ids?.data?.length ?? 0;
  if (!Number.isSafeInteger(length) || length <= 0) {
    throw new Error('The configured Transformers tokenizer returned no input_ids.');
  }
  return length;
}

function createHeuristicCounter(): ContextTokenCounter {
  return {
    mode: 'heuristic',
    model: null,
    limitations: [
      'Token counts use the local UTF-8 byte/4 heuristic; provider tokenizer counts are unavailable.',
    ],
    count: async (text: string) => estimateContextTokens(text),
  };
}

/**
 * Create an explicit context token counter.
 *
 * Transformers.js is intentionally loaded only when requested. This keeps
 * the default package install small and preserves offline operation. Failure
 * is surfaced to the caller because a requested measured plan must never be
 * silently downgraded to an estimate.
 */
export async function createContextTokenCounter(
  options: {
    mode?: ContextTokenizerMode;
    model?: string;
  } = {},
): Promise<ContextTokenCounter> {
  if ((options.mode ?? 'heuristic') === 'heuristic') return createHeuristicCounter();

  const model = options.model?.trim() || 'Xenova/all-MiniLM-L6-v2';
  try {
    const module =
      (await import('@huggingface/transformers')) as unknown as TransformerTokenizerModule;
    const tokenizer = await module.AutoTokenizer.from_pretrained(model);
    return {
      mode: 'transformers',
      model,
      limitations: [
        `Token count measured by Transformers.js tokenizer model "${model}"; provider billing may still add prompt overhead.`,
      ],
      count: async (text: string) => countTransformerOutput(await tokenizer(text)),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Transformers tokenizer "${model}" is unavailable. Install the optional @huggingface/transformers provider or use --tokenizer heuristic. Details: ${detail}`,
    );
  }
}

/** Count a validated source file without exposing its content to the caller. */
export async function countContextFileTokens(
  filePath: string,
  counter: ContextTokenCounter,
): Promise<number> {
  const content = await readFile(filePath, 'utf8');
  return counter.count(content);
}
