import type { ReviewBundle } from './bundle.js';

export interface ReviewBundleWorkerContext {
  bundle: ReviewBundle;
  attempt: number;
  signal: AbortSignal;
}

export type ReviewBundleWorker<T> = (context: ReviewBundleWorkerContext) => Promise<T> | T;

export interface ReviewBundleExecutionOptions {
  concurrency?: number;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface ReviewBundleExecutionResult<T> {
  bundleId: string;
  status: 'completed' | 'failed' | 'timed-out';
  attempts: number;
  durationMs: number;
  value?: T;
  error?: {
    code: 'review.bundle-timeout' | 'review.bundle-failed';
    message: string;
  };
}

export interface ReviewBundleExecution<T> {
  results: ReviewBundleExecutionResult<T>[];
  completed: number;
  failed: number;
  timedOut: number;
  complete: boolean;
  concurrency: number;
  timeoutMs: number;
  maxRetries: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 1;

function checkedInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < min || candidate > max) {
    throw new Error(`Review bundle worker option must be an integer between ${min} and ${max}.`);
  }
  return candidate;
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const singleLine = message.replace(/[\r\n\t]+/g, ' ').trim();
  return singleLine.slice(0, 500) || 'Bundle worker failed without an error message.';
}

function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  controller: AbortController,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`Review bundle worker timed out after ${timeoutMs} ms.`));
    }, timeoutMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function executeOne<T>(
  bundle: ReviewBundle,
  worker: ReviewBundleWorker<T>,
  timeoutMs: number,
  maxRetries: number,
): Promise<ReviewBundleExecutionResult<T>> {
  const startedAt = performance.now();
  let lastError: unknown;
  let timedOut = false;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    const controller = new AbortController();
    try {
      const value = await withTimeout(
        Promise.resolve(worker({ bundle, attempt, signal: controller.signal })),
        timeoutMs,
        controller,
      );
      return {
        bundleId: bundle.id,
        status: 'completed',
        attempts: attempt,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        value,
      };
    } catch (error) {
      lastError = error;
      timedOut =
        error instanceof Error && error.message.startsWith('Review bundle worker timed out');
    }
  }

  return {
    bundleId: bundle.id,
    status: timedOut ? 'timed-out' : 'failed',
    attempts: maxRetries + 1,
    durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
    error: {
      code: timedOut ? 'review.bundle-timeout' : 'review.bundle-failed',
      message: safeErrorMessage(lastError),
    },
  };
}

/**
 * Execute review bundles with bounded concurrency while returning results in
 * canonical bundle order. Workers should observe `signal`; timeout is
 * cooperative for already-running asynchronous work.
 */
export async function executeReviewBundles<T>(
  bundles: readonly ReviewBundle[],
  worker: ReviewBundleWorker<T>,
  options: ReviewBundleExecutionOptions = {},
): Promise<ReviewBundleExecution<T>> {
  const concurrency = checkedInteger(options.concurrency, 2, 1, 32);
  const timeoutMs = checkedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1, 300_000);
  const maxRetries = checkedInteger(options.maxRetries, DEFAULT_MAX_RETRIES, 0, 5);
  const results = new Array<ReviewBundleExecutionResult<T>>(bundles.length);
  let nextIndex = 0;

  async function consume(): Promise<void> {
    while (nextIndex < bundles.length) {
      const index = nextIndex++;
      results[index] = await executeOne(bundles[index]!, worker, timeoutMs, maxRetries);
    }
  }

  const workerCount = Math.min(concurrency, bundles.length);
  await Promise.all(Array.from({ length: workerCount }, () => consume()));
  const completed = results.filter((result) => result.status === 'completed').length;
  const timedOut = results.filter((result) => result.status === 'timed-out').length;
  const failed = results.length - completed - timedOut;
  return {
    results,
    completed,
    failed,
    timedOut,
    complete: completed === results.length,
    concurrency,
    timeoutMs,
    maxRetries,
  };
}
