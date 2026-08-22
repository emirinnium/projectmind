/**
 * Centralized error handling utilities for ProjectMind.
 * 
 * Provides type-safe error handling patterns:
 * - {@link Result} type for explicit error propagation
 * - {@link tryCatch} / {@link tryCatchAsync} for converting exceptions to values
 * - {@link safeExecute} / {@link safeExecuteAsync} for logging swallowed errors
 * - {@link assert} / {@link require} for invariants
 * 
 * @example
 * ```typescript
 * const result = tryCatch(() => JSON.parse(maybeJson));
 * if (!result.success) {
 *   logger.warn(`Parse failed: ${result.error.message}`);
 * } else {
 *   useValue(result.value);
 * }
 * ```
 * 
 * @module utils/errors
 */

import { logger } from './logger.js';

/**
 * Result type for operations that can fail.
 * Forces explicit error handling instead of try/catch swallowing.
 * 
 * @typeParam T - The success value type
 * @typeParam E - The error type (defaults to Error)
 */
export type Result<T, E = Error> = 
  | { success: true; value: T }
  | { success: false; error: E };

/**
 * Wrap a synchronous function to return a Result instead of throwing.
 * 
 * @param fn - Function that might throw
 * @param context - Optional context name for debug logging
 * @returns Result with value or error
 * 
 * @example
 * ```typescript
 * const result = tryCatch(() => fs.readFileSync(path, 'utf-8'));
 * if (!result.success) {
 *   // handle error
 * }
 * ```
 */
export function tryCatch<T>(fn: () => T, context?: string): Result<T> {
  try {
    return { success: true, value: fn() };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    if (context) {
      logger.debug(`Error in ${context}: ${err.message}`);
    }
    return { success: false, error: err };
  }
}

/**
 * Wrap an async function to return a Result instead of throwing.
 */
export async function tryCatchAsync<T>(fn: () => Promise<T>, context?: string): Promise<Result<T>> {
  try {
    const value = await fn();
    return { success: true, value };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    if (context) {
      logger.debug(`Error in ${context}: ${err.message}`);
    }
    return { success: false, error: err };
  }
}

/**
 * Safely execute a callback, logging any errors instead of silently swallowing them.
 * Use this to replace empty catch blocks.
 */
export function safeExecute(fn: () => void, context: string): void {
  try {
    fn();
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.warn(`${context} - suppressed error: ${err.message}`);
  }
}

/**
 * Safely execute an async callback, logging any errors instead of silently swallowing them.
 */
export async function safeExecuteAsync(fn: () => Promise<void>, context: string): Promise<void> {
  try {
    await fn();
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.warn(`${context} - suppressed error: ${err.message}`);
  }
}

/**
 * Assert a condition, throwing a descriptive error if it fails.
 */
export function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

/**
 * Require a value to be non-null, throwing a descriptive error if it is.
 */
export function require<T>(value: T | null | undefined, name: string): T {
  if (value === null || value === undefined) {
    throw new Error(`Required value '${name}' is ${value === null ? 'null' : 'undefined'}`);
  }
  return value;
}
