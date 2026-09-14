import { readFileSync } from 'node:fs';
import { assertProjectPath } from '@/core/security/path-security.js';
import { stableHash } from '@/utils/hash.js';
import type { ReplayEvent } from './agent-replay.js';

export type ContextReconstructionStatus = 'recorded' | 'diverged' | 'unavailable';

export interface ReconstructedContextFile {
  path: string;
  status: ContextReconstructionStatus;
  recordedHash?: string;
  currentHash?: string;
  content?: string;
  reason?: string;
}

export interface ContextReconstruction {
  status: ContextReconstructionStatus;
  files: ReconstructedContextFile[];
  reason?: string;
}

function parseStringArray(value: unknown): string[] | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) return null;
    return [...new Set(parsed.map((item) => item.replace(/\\/g, '/')))].sort();
  } catch {
    return null;
  }
}

function parseHashMap(value: unknown): Record<string, string> | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const result: Record<string, string> = {};
    for (const [path, hash] of Object.entries(parsed as Record<string, unknown>)) {
      if (!/^[a-f0-9]{64}$/i.test(hash as string)) return null;
      result[path.replace(/\\/g, '/')] = hash as string;
    }
    return result;
  } catch {
    return null;
  }
}

/**
 * Reconstruct a recorded context only from its payload-free path/hash
 * snapshot. Current source is returned only when its hash still matches the
 * recorded version; callers should wrap it as untrusted source content.
 */
export function reconstructContext(
  projectRoot: string,
  event: Pick<ReplayEvent, 'eventType' | 'outcome'>,
  includeSource = false,
): ContextReconstruction {
  if (event.eventType !== 'context') {
    return { status: 'unavailable', files: [], reason: 'The event is not a context decision.' };
  }
  const paths = parseStringArray(event.outcome.selectedPaths);
  const hashes = parseHashMap(event.outcome.selectedSourceHashes);
  if (!paths || !hashes) {
    return {
      status: 'unavailable',
      files: [],
      reason: 'The event predates context snapshots or its snapshot metadata is malformed.',
    };
  }

  const files = paths.map((path): ReconstructedContextFile => {
    const recordedHash = hashes[path];
    if (!recordedHash) {
      return {
        path,
        status: 'unavailable',
        reason: 'The context snapshot has no source hash for this path.',
      };
    }
    try {
      const absolutePath = assertProjectPath(path, projectRoot, {
        mustExist: true,
        rejectIgnored: true,
      });
      const content = readFileSync(absolutePath, 'utf8').replace(/^\uFEFF/, '');
      const currentHash = stableHash(content);
      if (currentHash !== recordedHash) {
        return {
          path,
          status: 'diverged',
          recordedHash,
          currentHash,
          reason: 'Current source hash differs from the recorded context snapshot.',
        };
      }
      return {
        path,
        status: 'recorded',
        recordedHash,
        currentHash,
        ...(includeSource ? { content } : {}),
      };
    } catch (error) {
      return {
        path,
        status: 'unavailable',
        recordedHash,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  });
  const status: ContextReconstructionStatus = files.some((file) => file.status === 'diverged')
    ? 'diverged'
    : files.some((file) => file.status === 'unavailable')
      ? 'unavailable'
      : 'recorded';
  return {
    status,
    files,
    ...(status === 'recorded'
      ? {}
      : { reason: 'At least one recorded context file is no longer exactly reproducible.' }),
  };
}
