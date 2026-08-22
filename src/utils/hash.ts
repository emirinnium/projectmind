import { createHash } from 'node:crypto';

/**
 * Stable content hash used for cache keys and change detection.
 *
 * Replaces five divergent copies of a collision-prone 32-bit rolling hash
 * (coherence fast/deep analyzers, genome checksum, coherence-cache,
 * embedding-cache) where different inputs could collide and silently
 * overwrite each other's entries.
 */
export function stableHash(input: string): string {
  return createHash('md5').update(input).digest('hex');
}
