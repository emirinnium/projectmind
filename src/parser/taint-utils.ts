/**
 * Shared taint analysis utilities.
 *
 * This module provides common functions used by taint analyzers to ensure
 * consistent handling of identity strings across the codebase.
 */

/**
 * Sanitize an identity string by removing invalid characters.
 *
 * Identity strings are used as resource identifiers in the knowledge graph
 * and may be written to debug logs or database. This function:
 * 1. Strips control characters (0x00-0x1F, 0x7F)
 * 2. Removes newlines and tabs
 * 3. Trims whitespace
 * 4. Limits length to prevent unbounded strings
 *
 * @param identity - The raw identity string to sanitize
 * @param maxLength - Maximum allowed length (default: 200)
 * @returns The sanitized identity string
 */
export function sanitizeIdentity(identity: string, maxLength = 200): string {
  if (!identity) return '';

  // Remove control characters (0x00-0x1F and 0x7F), newlines, tabs
  // Note: \r\n\t are already covered by \x00-\x1F range, but we keep them
  // explicit for clarity and to handle any edge cases
  let sanitized = identity
    .replace(/[\x00-\x1F\x7F\r\n\t]/g, '') // Control characters, newlines, tabs
    .trim();

  // Limit length to prevent unbounded strings
  if (sanitized.length > maxLength) {
    sanitized = sanitized.slice(0, maxLength);
  }

  return sanitized;
}
