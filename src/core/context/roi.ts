import type { ContextBudgetPlan, ContextItem } from './types.js';
import type { ContextTokenizerMode } from './tokenizer.js';
import {
  assessContextPricing,
  type ContextPricingRecord,
  type ContextPricingStatus,
} from './pricing.js';

export interface ContextRoi {
  status: 'estimated' | 'measured';
  /** Backwards-compatible measurement label retained for 1.0.x consumers. */
  tokenMeasurement: 'estimated-char-div-4' | 'provider-transformers';
  /** Accurate accounting mechanism used for the returned token values. */
  tokenAccounting: 'estimated-utf8-byte-div-4' | 'provider-tokenizer';
  tokenizerModel: string | null;
  candidateFiles: number;
  selectedFiles: number;
  excludedFiles: number;
  candidateTokens: number;
  allocatedTokens: number;
  estimatedSavedTokens: number;
  estimatedSavedPercent: number;
  candidateBytes: number | null;
  allocatedBytes: number | null;
  estimatedSavedBytes: number | null;
  estimatedSavedBytesPercent: number | null;
  inputPricePer1k: number | null;
  outputPricePer1k: number | null;
  pricingStatus: ContextPricingStatus;
  pricingSource: string | null;
  pricingEffectiveAt: string | null;
  pricingExpiresAt: string | null;
  candidateCostUsd: number | null;
  allocatedCostUsd: number | null;
  estimatedSavedCostUsd: number | null;
  relevanceCoverage: number;
  limitations: string[];
}

export interface ContextRoiOptions {
  /** Provider input price in USD per 1,000 input tokens, when known. */
  inputPricePer1k?: number;
  /** Auditable provider price record; direct inputPricePer1k takes precedence. */
  pricing?: ContextPricingRecord;
  /** Explicitly describes how item.tokens were obtained. */
  tokenMeasurement?: ContextTokenizerMode;
  /** Model identifier when tokenMeasurement is provider-backed. */
  tokenizerModel?: string;
}

export type ContextPlanVariant =
  'full-file' | 'budgeted-file' | 'byte-range' | 'canonical-example' | 'graph-closure';

export interface ContextPlanVariantInput {
  variant: ContextPlanVariant;
  plan?: ContextBudgetPlan;
  limitations?: readonly string[];
}

export interface ContextPlanComparison {
  variant: ContextPlanVariant;
  available: boolean;
  roi: ContextRoi | null;
  limitations: string[];
}

/**
 * Compare retrieval plans without inventing a byte-range or graph result.
 * Callers provide the plans that were actually produced; an unavailable
 * variant remains explicit so reports cannot mistake a missing adapter for a
 * zero-cost or zero-token plan.
 */
export function compareContextPlans(
  items: readonly ContextItem[],
  variants: readonly ContextPlanVariantInput[],
  options: ContextRoiOptions = {},
): ContextPlanComparison[] {
  const seen = new Set<ContextPlanVariant>();
  return variants
    .filter((entry) => {
      if (seen.has(entry.variant)) return false;
      seen.add(entry.variant);
      return true;
    })
    .map((entry) => {
      const limitations = [...(entry.limitations ?? [])];
      if (!entry.plan) {
        limitations.push(
          `${entry.variant} plan was not produced; no token, byte, cost, or relevance claim is made.`,
        );
        return { variant: entry.variant, available: false, roi: null, limitations };
      }
      return {
        variant: entry.variant,
        available: true,
        roi: calculateContextRoi(items, entry.plan, options),
        limitations,
      };
    });
}

/**
 * Compare a selected context plan with the full candidate set. This reports
 * measurable selection arithmetic only; it does not pretend excluded tokens
 * equal provider billing savings or that signatures are lossless compression.
 */
export function calculateContextRoi(
  items: readonly ContextItem[],
  plan: ContextBudgetPlan,
  options: ContextRoiOptions = {},
): ContextRoi {
  const tokenEstimate = (tokens: number): number =>
    Number.isFinite(tokens) ? Math.max(0, Math.round(tokens)) : 0;
  const relevance = (score: number): number => (Number.isFinite(score) ? Math.max(0, score) : 0);
  const candidateTokens = items.reduce((sum, item) => sum + tokenEstimate(item.tokens), 0);
  const measuredBytes = items.every(
    (item) => Number.isFinite(item.bytes) && (item.bytes ?? 0) >= 0,
  );
  const candidateBytes = measuredBytes
    ? items.reduce((sum, item) => sum + Math.max(0, Math.round(item.bytes ?? 0)), 0)
    : null;
  const selectedBytes = measuredBytes
    ? plan.selectedItems.reduce((sum, item) => sum + Math.max(0, Math.round(item.bytes ?? 0)), 0)
    : null;
  const candidateRelevance = items.reduce((sum, item) => sum + relevance(item.relevanceScore), 0);
  const selectedRelevance = plan.selectedItems.reduce((sum, item) => {
    const original = items.find((candidate) => candidate.path === item.path);
    return sum + relevance(original?.relevanceScore ?? item.relevanceScore);
  }, 0);
  const allocatedTokens = tokenEstimate(plan.allocatedTokens);
  const estimatedSavedTokens = Math.max(0, candidateTokens - allocatedTokens);
  const pricingRecord =
    options.inputPricePer1k === undefined
      ? options.pricing
      : options.pricing?.inputPricePer1k === options.inputPricePer1k
        ? options.pricing
        : { inputPricePer1k: options.inputPricePer1k };
  const pricing = assessContextPricing(pricingRecord);
  const inputPricePer1k = pricing.inputPricePer1k;
  const roundUsd = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;
  const candidateCostUsd =
    inputPricePer1k === null ? null : roundUsd((candidateTokens / 1000) * inputPricePer1k);
  const allocatedCostUsd =
    inputPricePer1k === null ? null : roundUsd((allocatedTokens / 1000) * inputPricePer1k);
  const estimatedSavedCostUsd =
    candidateCostUsd === null || allocatedCostUsd === null
      ? null
      : roundUsd(Math.max(0, candidateCostUsd - allocatedCostUsd));
  const rawCoverage = candidateRelevance === 0 ? 0 : selectedRelevance / candidateRelevance;
  const tokenMeasurement =
    options.tokenMeasurement === 'transformers' ? 'provider-transformers' : 'estimated-char-div-4';
  const tokenAccounting =
    options.tokenMeasurement === 'transformers'
      ? 'provider-tokenizer'
      : 'estimated-utf8-byte-div-4';
  const measured = tokenMeasurement === 'provider-transformers';
  return {
    status: measured ? 'measured' : 'estimated',
    tokenMeasurement,
    tokenAccounting,
    tokenizerModel: measured ? (options.tokenizerModel ?? null) : null,
    candidateFiles: items.length,
    selectedFiles: plan.files.length,
    excludedFiles: plan.excludedFiles.length,
    candidateTokens,
    allocatedTokens,
    estimatedSavedTokens,
    estimatedSavedPercent:
      candidateTokens === 0
        ? 0
        : Math.round((estimatedSavedTokens / candidateTokens) * 10000) / 100,
    candidateBytes,
    allocatedBytes: selectedBytes,
    estimatedSavedBytes:
      candidateBytes === null || selectedBytes === null
        ? null
        : Math.max(0, candidateBytes - selectedBytes),
    estimatedSavedBytesPercent:
      candidateBytes === null || candidateBytes === 0 || selectedBytes === null
        ? null
        : Math.round(((candidateBytes - selectedBytes) / candidateBytes) * 10000) / 100,
    inputPricePer1k,
    outputPricePer1k: pricing.outputPricePer1k,
    pricingStatus: pricing.status,
    pricingSource: pricing.source,
    pricingEffectiveAt: pricing.effectiveAt,
    pricingExpiresAt: pricing.expiresAt,
    candidateCostUsd,
    allocatedCostUsd,
    estimatedSavedCostUsd,
    relevanceCoverage: Math.min(1, Math.max(0, Math.round(rawCoverage * 10000) / 10000)),
    limitations: [
      ...(measured
        ? []
        : [
            'Token counts use the local UTF-8 byte/4 heuristic; provider tokenizer counts are unavailable.',
            'Token counts are estimates unless a provider tokenizer is explicitly selected.',
          ]),
      'Estimated excluded tokens are not a billing guarantee; provider prompt overhead and cached-token pricing are unavailable here.',
      'Compression hints describe a possible transformation and are not counted as lossless savings.',
      ...(candidateBytes === null
        ? [
            'Exact source bytes were not supplied for every candidate; byte savings are unavailable.',
          ]
        : []),
      ...(inputPricePer1k === null
        ? [pricing.limitation ?? 'Input price was not supplied; dollar savings are unavailable.']
        : [
            measured
              ? pricing.status === 'current'
                ? 'Dollar values are local estimates from the supplied current price and measured tokenizer tokens; provider billing overhead is not included.'
                : 'Dollar values are local estimates from the supplied input price and measured tokenizer tokens; price provenance is incomplete and provider billing overhead is not included.'
              : pricing.status === 'current'
                ? 'Dollar values are local estimates from the supplied current price and estimated tokens.'
                : 'Dollar values are local estimates from the supplied input price and estimated tokens; price provenance is incomplete.',
          ]),
    ],
  };
}
