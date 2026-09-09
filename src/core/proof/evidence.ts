import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { KnowledgeGraph } from '../../storage/knowledge-graph.js';
import type { FileInfo } from '../../storage/kg/types.js';
import { stableHash } from '../../utils/hash.js';

/** The source of a fact returned by ProjectMind. */
export type EvidenceKind =
  'direct-source' | 'indexed-graph' | 'ast' | 'type-service' | 'semantic' | 'runtime' | 'heuristic';

/** A precise, inspectable reference supporting an analysis result. */
export interface EvidenceReference {
  filePath: string;
  kind: EvidenceKind;
  relation?: string;
  lineStart?: number;
  lineEnd?: number;
  sourceHash?: string;
  indexedHash?: string;
  note?: string;
}

export type FreshnessStatus = 'fresh' | 'stale' | 'unindexed' | 'missing' | 'unknown';
export type VerificationStatus = 'verified' | 'partial' | 'stale' | 'unverified' | 'conflict';

export interface FileFreshness {
  filePath: string;
  status: FreshnessStatus;
  sourceHash?: string;
  indexedHash?: string;
  indexedAt?: string;
  sizeBytes?: number;
  lineCount?: number;
  error?: string;
}

export interface FreshnessSummary {
  status: VerificationStatus;
  checkedAt: string;
  checkedFiles: number;
  freshFiles: number;
  staleFiles: number;
  unindexedFiles: number;
  missingFiles: number;
  unknownFiles: number;
  details: FileFreshness[];
}

export interface VerificationDetails {
  graphFresh: boolean;
  sourceVerified: boolean;
  astVerified: boolean;
  typecheckVerified: boolean;
  runtimeVerified: boolean;
  status: VerificationStatus;
  limitations: string[];
}

export interface EvidencePacket {
  evidence: EvidenceReference[];
  freshness: FreshnessSummary;
  verification: VerificationDetails;
  confidence: number;
  claimStatus: VerificationStatus | 'insufficient-evidence';
}

/** A structured result wrapper that keeps old payload fields intact. */
export type EvidenceAttached<T extends object> = T & { evidence: EvidencePacket };

function confinedProjectPath(projectRoot: string, filePath: string): string {
  const root = resolve(projectRoot);
  const absolute = resolve(root, filePath);
  const relativePath = relative(root, absolute);
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error(`Evidence path escapes the project root: ${filePath}`);
  }
  return absolute;
}

function normalizedRelativePath(projectRoot: string, filePath: string): string {
  const absolute = confinedProjectPath(projectRoot, filePath);
  const relativePath = relative(resolve(projectRoot), absolute);
  return relativePath === '' ? '.' : relativePath.replace(/\\/g, '/');
}

function statusFromDetails(details: FileFreshness[]): VerificationStatus {
  if (details.length === 0) return 'unverified';
  if (details.some((item) => item.status === 'stale')) return 'stale';
  if (details.some((item) => item.status === 'unknown')) return 'conflict';
  if (details.some((item) => item.status === 'missing')) return 'partial';
  if (details.some((item) => item.status === 'unindexed')) return 'partial';
  return 'verified';
}

function confidenceFromStatus(status: VerificationStatus, details: FileFreshness[]): number {
  if (details.length === 0) return 0;
  switch (status) {
    case 'verified':
      return 1;
    case 'partial':
      return 0.55;
    case 'stale':
      return 0.2;
    case 'conflict':
      return 0;
    case 'unverified':
      return 0;
  }
}

/**
 * Read the current source and compare its cryptographic hash with the graph.
 * This deliberately returns an explicit state for every failure; callers
 * must not silently treat an unreadable or unindexed file as fresh.
 */
export async function verifyFileFreshness(
  kg: KnowledgeGraph,
  projectRoot: string,
  filePath: string,
): Promise<FileFreshness> {
  const relativePath = normalizedRelativePath(projectRoot, filePath);
  const indexed: FileInfo | null = kg.getFileByPath(filePath) ?? kg.getFileByPath(relativePath);
  const absolutePath = confinedProjectPath(projectRoot, filePath);

  let content: string;
  let fileStats: { size: number };
  try {
    [content, fileStats] = await Promise.all([readFile(absolutePath, 'utf8'), stat(absolutePath)]);
  } catch (error) {
    if (!indexed) {
      return {
        filePath: relativePath,
        status: 'missing',
        error: error instanceof Error ? error.message : String(error),
      };
    }
    return {
      filePath: relativePath,
      status: 'missing',
      indexedHash: indexed.hash,
      indexedAt: indexed.lastScanned,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  // The scanner strips a UTF-8 BOM before hashing. Mirror that normalization
  // here so a BOM is not reported as a false stale change across platforms.
  const normalizedContent = content.replace(/^\uFEFF/, '');
  const sourceHash = stableHash(normalizedContent);
  const lineCount = normalizedContent.length === 0 ? 0 : normalizedContent.split(/\r?\n/).length;
  if (!indexed) {
    return {
      filePath: relativePath,
      status: 'unindexed',
      sourceHash,
      sizeBytes: fileStats.size,
      lineCount,
    };
  }

  const indexedHash = indexed.hash || undefined;
  return {
    filePath: relativePath,
    status: indexedHash && sourceHash === indexedHash ? 'fresh' : 'stale',
    sourceHash,
    indexedHash,
    indexedAt: indexed.lastScanned,
    sizeBytes: fileStats.size,
    lineCount,
    ...(indexedHash ? {} : { error: 'Indexed file has no content hash.' }),
  };
}

/** Verify a selected set of files or every visible indexed file. */
export async function verifyProjectFreshness(
  kg: KnowledgeGraph,
  projectRoot: string,
  filePaths?: string[],
): Promise<FreshnessSummary> {
  const paths =
    filePaths && filePaths.length > 0
      ? [...new Set(filePaths)]
      : kg.getAllFiles().map((file) => file.relativePath || file.path);
  const details: FileFreshness[] = [];
  for (const path of paths) {
    try {
      details.push(await verifyFileFreshness(kg, projectRoot, path));
    } catch (error) {
      details.push({
        filePath: path.replace(/\\/g, '/'),
        status: 'unknown',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const status = statusFromDetails(details);
  return {
    status,
    checkedAt: new Date().toISOString(),
    checkedFiles: details.length,
    freshFiles: details.filter((item) => item.status === 'fresh').length,
    staleFiles: details.filter((item) => item.status === 'stale').length,
    unindexedFiles: details.filter((item) => item.status === 'unindexed').length,
    missingFiles: details.filter((item) => item.status === 'missing').length,
    unknownFiles: details.filter((item) => item.status === 'unknown').length,
    details,
  };
}

/** Build the standard evidence object for an analysis over selected files. */
export function buildEvidencePacket(
  freshness: FreshnessSummary,
  options: {
    evidence?: EvidenceReference[];
    astVerified?: boolean;
    typecheckVerified?: boolean;
    runtimeVerified?: boolean;
    limitations?: string[];
  } = {},
): EvidencePacket {
  const limitations = [...(options.limitations ?? [])];
  if (freshness.status === 'stale') {
    limitations.push('One or more source files changed after the graph was indexed.');
  }
  if (freshness.status === 'partial') {
    limitations.push('At least one file is missing from the graph or could not be verified.');
  }
  if (freshness.status === 'conflict') {
    limitations.push('Freshness checks returned conflicting or unreadable evidence.');
  }

  const astVerified = options.astVerified ?? false;
  const typecheckVerified = options.typecheckVerified ?? false;
  const runtimeVerified = options.runtimeVerified ?? false;
  const status = freshness.status;
  return {
    evidence: options.evidence ?? [],
    freshness,
    verification: {
      graphFresh: status === 'verified',
      sourceVerified: freshness.freshFiles === freshness.checkedFiles && freshness.checkedFiles > 0,
      astVerified,
      typecheckVerified,
      runtimeVerified,
      status,
      limitations,
    },
    confidence: confidenceFromStatus(status, freshness.details),
    claimStatus: status,
  };
}

/**
 * Produce a conservative packet for a natural-language claim with no source
 * locations. The claim is intentionally not guessed from semantic similarity.
 */
export function insufficientEvidencePacket(reason: string): EvidencePacket {
  const freshness: FreshnessSummary = {
    status: 'unverified',
    checkedAt: new Date().toISOString(),
    checkedFiles: 0,
    freshFiles: 0,
    staleFiles: 0,
    unindexedFiles: 0,
    missingFiles: 0,
    unknownFiles: 0,
    details: [],
  };
  return {
    evidence: [],
    freshness,
    verification: {
      graphFresh: false,
      sourceVerified: false,
      astVerified: false,
      typecheckVerified: false,
      runtimeVerified: false,
      status: 'unverified',
      limitations: [reason],
    },
    confidence: 0,
    claimStatus: 'insufficient-evidence',
  };
}

/** Attach evidence without changing the shape of the existing result. */
export function attachEvidence<T extends object>(
  payload: T,
  evidence: EvidencePacket,
): EvidenceAttached<T> {
  return { ...payload, evidence };
}
