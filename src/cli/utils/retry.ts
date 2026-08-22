import { runWithRetry as coreRunWithRetry } from '@/storage/database-utils.js';
import type { RetryOptions } from '@/storage/database-utils.js';

export type { RetryOptions };

/**
 * CLI-facing retry helper. Delegates to the single canonical implementation
 * in storage/database-utils (previously a near-duplicate with divergent
 * defaults); preserves this module's original default delay semantics.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    baseDelayMs = 1000,
    maxDelayMs = 10000,
    backoffMultiplier = 2,
    retryableErrors = ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'timeout', 'network'],
    onRetry,
  } = options;

  return coreRunWithRetry(fn, {
    maxAttempts,
    baseDelayMs,
    maxDelayMs,
    backoffMultiplier,
    retryableErrors,
    onRetry,
  });
}

// Re-export for callers that want the storage-default variant directly.
export { coreRunWithRetry };
