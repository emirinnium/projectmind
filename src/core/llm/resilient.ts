import type { LLMProvider, LLMResponse } from './types.js';
import { logger } from '../../utils/logger.js';

/**
 * Resilience decorator for LLM providers:
 *  - retry with exponential backoff on transient failures
 *    (429/rate-limit, timeouts, network errors, 5xx)
 *  - naive client-side rate limiting between consecutive calls
 *
 * The whole MCP/CLI surface goes through the factory, so every provider gets
 * this behavior without touching individual implementations.
 */

const RETRYABLE = /429|rate.?limit|too many requests|timeout|timed?\s*out|econn|enotfound|eai_again|socket|5\d\d/i;

export interface ResilienceOptions {
  /** Attempts beyond the first one. Default 2 (i.e. up to 3 calls total). */
  maxRetries?: number;
  /** Minimum spacing between consecutive calls (client-side rate limit). */
  minIntervalMs?: number;
}

interface RateLimitedProvider extends LLMProvider {
  __lastCallAt?: number;
}

export function withProviderResilience(
  provider: LLMProvider,
  opts: ResilienceOptions = {}
): LLMProvider {
  const maxRetries = opts.maxRetries ?? 2;
  const minIntervalMs = opts.minIntervalMs ?? 1200;

  const wrapped = provider as RateLimitedProvider;

  return {
    name: provider.name,
    model: provider.model,
    isAvailable: () => provider.isAvailable(),

    async analyze(prompt: string, systemPrompt?: string, temperature?: number): Promise<LLMResponse> {
      // Client-side rate limiting: space calls apart.
      const last = wrapped.__lastCallAt ?? 0;
      const wait = last + minIntervalMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));

      let attempt = 0;
      for (;;) {
        wrapped.__lastCallAt = Date.now();
        try {
          return await provider.analyze(prompt, systemPrompt, temperature);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          attempt++;
          if (attempt > maxRetries || !RETRYABLE.test(msg)) throw e;
          const backoffMs = Math.min(8000, minIntervalMs * 2 ** attempt);
          logger.warn(
            `[llm:${provider.name}] transient failure (${msg.slice(0, 120)}) — retry ${attempt}/${maxRetries} in ${backoffMs}ms`
          );
          await new Promise((r) => setTimeout(r, backoffMs));
        }
      }
    },
  };
}
