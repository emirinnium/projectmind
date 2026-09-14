import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { assertProjectPath } from '../security/path-security.js';
import { policyIncludesFile, type ReviewPolicy } from './policy.js';
import type { ReviewGraphClosure } from './graph-closure.js';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

export interface ReviewBundleFile {
  relativePath: string;
  sourceHash: string;
  bytes: number;
  lineEnding: 'lf' | 'crlf' | 'mixed' | 'none';
  estimatedTokens: number;
}

export interface ReviewBundle {
  id: string;
  inputHash: string;
  files: ReviewBundleFile[];
  estimatedBytes: number;
  estimatedTokens: number;
  oversized: boolean;
}

export interface ReviewBundlePlan {
  bundles: ReviewBundle[];
  excluded: Array<{ relativePath: string; reason: string }>;
  inputHash: string;
  allowedLineRanges?: Record<string, Array<[number, number]>>;
  graphClosure?: ReviewGraphClosure;
}

export interface ReviewBundleOptions {
  maxBytes?: number;
  maxTokens?: number;
  allowedLineRanges?: Record<string, Array<[number, number]>>;
  graphClosure?: ReviewGraphClosure;
}

function lineEnding(content: string): ReviewBundleFile['lineEnding'] {
  const crlf = (content.match(/\r\n/g) ?? []).length;
  const lf = (content.match(/(?<!\r)\n/g) ?? []).length;
  if (crlf === 0 && lf === 0) return 'none';
  if (crlf > 0 && lf > 0) return 'mixed';
  return crlf > 0 ? 'crlf' : 'lf';
}

function isBinary(content: Buffer): boolean {
  return content.subarray(0, Math.min(content.length, 8192)).includes(0);
}

/** Deterministically split changed source files into bounded, source-hashed review units. */
export function planReviewBundles(
  changedFiles: readonly string[],
  projectRoot: string,
  policy: ReviewPolicy,
  options: ReviewBundleOptions = {},
): ReviewBundlePlan {
  const maxBytes = options.maxBytes ?? policy.maxBundleBytes;
  const maxTokens = options.maxTokens ?? policy.maxBundleTokens;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 50_000_000)
    throw new Error('Review bundle maxBytes must be an integer between 1 and 50000000.');
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 10_000_000)
    throw new Error('Review bundle maxTokens must be an integer between 1 and 10000000.');
  const candidates: ReviewBundleFile[] = [];
  const excluded: ReviewBundlePlan['excluded'] = [];

  for (const relativePath of [...new Set(changedFiles)].sort((a, b) => a.localeCompare(b))) {
    if (!policyIncludesFile(policy, relativePath)) {
      excluded.push({ relativePath, reason: 'excluded by review policy' });
      continue;
    }
    if (!SOURCE_EXTENSIONS.has(extname(relativePath).toLowerCase())) {
      excluded.push({ relativePath, reason: 'unsupported or non-source extension' });
      continue;
    }
    try {
      const absolutePath = assertProjectPath(relativePath, projectRoot, {
        mustExist: true,
        rejectIgnored: true,
      });
      const bytes = readFileSync(absolutePath);
      if (isBinary(bytes)) {
        excluded.push({ relativePath, reason: 'binary file' });
        continue;
      }
      const content = bytes.toString('utf8');
      const size = statSync(absolutePath).size;
      candidates.push({
        relativePath: relativePath.replace(/\\/g, '/'),
        sourceHash: createHash('sha256').update(bytes).digest('hex'),
        bytes: size,
        lineEnding: lineEnding(content),
        estimatedTokens: Math.max(1, Math.ceil(content.length / 4)),
      });
    } catch (error) {
      excluded.push({
        relativePath,
        reason: error instanceof Error ? error.message : 'unable to read source file',
      });
    }
  }

  const inputHash = createHash('sha256')
    .update(
      JSON.stringify({
        candidates,
        maxBytes,
        maxTokens,
        allowedLineRanges: options.allowedLineRanges ?? null,
        graphClosure: options.graphClosure ?? null,
        policy: {
          version: policy.version,
          mode: policy.mode,
          preset: policy.preset,
          include: policy.include,
          exclude: policy.exclude,
        },
      }),
    )
    .digest('hex');
  const bundles: ReviewBundle[] = [];
  let current: ReviewBundleFile[] = [];
  let bytes = 0;
  let tokens = 0;
  const flush = (): void => {
    if (current.length === 0) return;
    const files = current;
    const bundleInput = JSON.stringify(files);
    bundles.push({
      id: `review-${bundles.length + 1}-${createHash('sha256').update(bundleInput).digest('hex').slice(0, 12)}`,
      inputHash: createHash('sha256').update(bundleInput).digest('hex'),
      files,
      estimatedBytes: bytes,
      estimatedTokens: tokens,
      oversized: bytes > maxBytes || tokens > maxTokens,
    });
    current = [];
    bytes = 0;
    tokens = 0;
  };

  for (const file of candidates) {
    const wouldExceed =
      current.length > 0 &&
      (bytes + file.bytes > maxBytes || tokens + file.estimatedTokens > maxTokens);
    if (wouldExceed) flush();
    current.push(file);
    bytes += file.bytes;
    tokens += file.estimatedTokens;
  }
  flush();
  return {
    bundles,
    excluded,
    inputHash,
    allowedLineRanges: options.allowedLineRanges,
    graphClosure: options.graphClosure,
  };
}
