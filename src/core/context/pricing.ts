/**
 * A user-supplied provider price record.
 *
 * Prices are deliberately configuration data, not a hard-coded catalogue:
 * provider prices change and ProjectMind must not present stale numbers as a
 * billing guarantee. `source` and `effectiveAt` make a record auditable;
 * `expiresAt` prevents an old record from being used silently.
 */
export interface ContextPricingRecord {
  inputPricePer1k: number;
  outputPricePer1k?: number;
  currency?: 'USD';
  source?: string;
  effectiveAt?: string;
  expiresAt?: string;
}

export type ContextPricingStatus =
  'unavailable' | 'unverified' | 'current' | 'expired' | 'not-yet-effective';

export interface ContextPricingAssessment {
  status: ContextPricingStatus;
  inputPricePer1k: number | null;
  outputPricePer1k: number | null;
  source: string | null;
  effectiveAt: string | null;
  expiresAt: string | null;
  limitation?: string;
}

function validPrice(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0 && value <= 1000;
}

function validDate(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Assess a price record without making a network call or inventing current
 * provider pricing. Expired and future records are fail-closed for cost
 * arithmetic; records without provenance remain usable but are labelled
 * `unverified`.
 */
export function assessContextPricing(
  pricing: ContextPricingRecord | undefined,
  now = Date.now(),
): ContextPricingAssessment {
  if (!pricing || !validPrice(pricing.inputPricePer1k)) {
    return {
      status: 'unavailable',
      inputPricePer1k: null,
      outputPricePer1k: null,
      source: null,
      effectiveAt: null,
      expiresAt: null,
      limitation: 'Input price was not supplied or valid; dollar savings are unavailable.',
    };
  }

  const effectiveAtMs = validDate(pricing.effectiveAt);
  const expiresAtMs = validDate(pricing.expiresAt);
  const outputPricePer1k = validPrice(pricing.outputPricePer1k) ? pricing.outputPricePer1k : null;
  const common = {
    outputPricePer1k,
    source: pricing.source?.trim() || null,
    effectiveAt: pricing.effectiveAt ?? null,
    expiresAt: pricing.expiresAt ?? null,
  };

  if (effectiveAtMs !== null && effectiveAtMs > now) {
    return {
      status: 'not-yet-effective',
      inputPricePer1k: null,
      ...common,
      limitation:
        'The supplied provider price is not effective yet; dollar savings are unavailable.',
    };
  }
  if (expiresAtMs !== null && expiresAtMs <= now) {
    return {
      status: 'expired',
      inputPricePer1k: null,
      ...common,
      limitation: 'The supplied provider price has expired; update it before using dollar savings.',
    };
  }

  const hasProvenance = common.source !== null && effectiveAtMs !== null;
  return {
    status: hasProvenance ? 'current' : 'unverified',
    inputPricePer1k: pricing.inputPricePer1k,
    ...common,
    limitation: hasProvenance
      ? undefined
      : 'The supplied provider price has no complete source/effective date provenance; dollar values are unverified local estimates.',
  };
}
