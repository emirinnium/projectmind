export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  retryableErrors?: string[];
  onRetry?: (attempt: number, error: Error) => void;
}

export async function runWithRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    baseDelayMs = 100,
    maxDelayMs = 10000,
    backoffMultiplier = 2,
    retryableErrors = ['SQLITE_BUSY', 'SQLITE_LOCKED', 'database is locked', 'timeout', 'network', 'ECONNREFUSED', 'ETIMEDOUT', 'rate limit', '429', '500', '502', '503'],
    onRetry,
  } = options;

  let lastError: Error;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      const isRetryable = retryableErrors.some(e => lastError.message.includes(e));

      if (!isRetryable || attempt === maxAttempts) {
        throw lastError;
      }

      const delay = Math.min(
        baseDelayMs * Math.pow(backoffMultiplier, attempt - 1),
        maxDelayMs
      );

      if (onRetry) {
        onRetry(attempt, lastError);
      }

      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError!;
}
