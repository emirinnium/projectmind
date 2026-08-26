/**
 * Shared test-file detection used by the graph engine, impact analysis and
 * the smart context assembler. Single source of truth so "what counts as a
 * test" can never drift between features.
 */

/** True when the relative path looks like a test/spec file. */
export function isTestPath(relPath: string): boolean {
  return /(\.(test|spec)\.[tj]sx?$)|([\\/](tests?|__tests__)[\\/])|(\.spec\.)/i.test(relPath);
}
