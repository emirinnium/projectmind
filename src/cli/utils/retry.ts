import { logger } from '@/index.js';

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  retryableErrors?: string[];
  onRetry?: (attempt: number, error: Error) => void;
}

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

  let lastError: Error;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      
      const isRetryable = retryableErrors.some(e => 
        lastError.message.includes(e) || lastError.name.includes(e)
      );
      
      if (!isRetryable || attempt === maxAttempts) {
        throw lastError;
      }
      
      const delay = Math.min(
        baseDelayMs * Math.pow(backoffMultiplier, attempt - 1),
        maxDelayMs
      );
      
      if (onRetry) {
        onRetry(attempt, lastError);
      } else {
        logger.warn(`Attempt ${attempt}/${maxAttempts} failed: ${lastError.message}. Retrying in ${delay}ms...`);
      }
      
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  throw lastError!;
}
