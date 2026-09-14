import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { parseBenchmarkCorpusManifest } from './manifest.mjs';

const ReviewerIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/);
const RelativePathSchema = z.string().min(1).max(2000);
const LabelCaseSchema = z
  .object({
    caseKey: z.string().regex(/^[a-f0-9]{64}$/),
    expectedPaths: z.array(RelativePathSchema).max(100),
    unknown: z.boolean(),
    method: z.enum(['source-inspection', 'test-backed', 'runtime-trace', 'unknown']),
    evidence: z.array(z.string().trim().min(1).max(1000)).min(1).max(20),
  })
  .strict()
  .superRefine((label, context) => {
    if (label.unknown && label.expectedPaths.length > 0) {
      context.addIssue({
        code: 'custom',
        path: ['expectedPaths'],
        message: 'Unknown cases must not claim expected paths.',
      });
    }
    if (label.unknown && label.method !== 'unknown') {
      context.addIssue({
        code: 'custom',
        path: ['method'],
        message: 'Unknown cases must use the unknown labeling method.',
      });
    }
  });
export const BenchmarkLabelSubmissionSchema = z
  .object({
    version: z.literal(1),
    manifest: z
      .object({ name: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict(),
    reviewerId: ReviewerIdSchema,
    labels: z.array(LabelCaseSchema).min(1).max(10_000),
  })
  .strict();

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stablePaths(paths) {
  return [...new Set(paths.map((path) => path.replace(/\\/g, '/')))].sort((a, b) =>
    a.localeCompare(b, 'en'),
  );
}

function assertRelativePath(path, caseId) {
  const normalized = path.replace(/\\/g, '/');
  if (
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split('/').some((segment) => segment === '..')
  ) {
    throw new Error(`Label ${caseId} contains an unsafe repository-relative path: ${path}.`);
  }
}

function caseKey(repositoryId, caseId, manifestHash) {
  return sha256(`${manifestHash}\0${repositoryId}\0${caseId}`);
}

function manifestCases(manifest, manifestHash) {
  return manifest.cases.map(({ repositoryId, case: benchmarkCase }) => {
    const repository = manifest.repositories.find((item) => item.id === repositoryId);
    if (!repository) throw new Error(`Unknown repository in benchmark case: ${repositoryId}.`);
    return {
      caseKey: caseKey(repositoryId, benchmarkCase.id, manifestHash),
      repositoryId,
      repositoryUrl: repository.url,
      commitSha: repository.commitSha,
      id: benchmarkCase.id,
      query: benchmarkCase.query,
      kind: benchmarkCase.kind,
      ...(benchmarkCase.targetPath ? { targetPath: benchmarkCase.targetPath } : {}),
      ...(benchmarkCase.changedPaths ? { changedPaths: benchmarkCase.changedPaths } : {}),
    };
  });
}

/** Create a source-redacted packet that contains no existing golden answers. */
export function createLabelPacket(manifest, manifestHash, reviewerId) {
  const parsedReviewerId = ReviewerIdSchema.parse(reviewerId);
  return {
    version: 1,
    manifest: { name: manifest.name, sha256: manifestHash },
    reviewerId: parsedReviewerId,
    cases: manifestCases(manifest, manifestHash),
  };
}

function validateSubmission(submission, manifest, manifestHash) {
  const parsed = BenchmarkLabelSubmissionSchema.parse(submission);
  if (parsed.manifest.name !== manifest.name || parsed.manifest.sha256 !== manifestHash) {
    throw new Error(
      `Label submission ${parsed.reviewerId} is tied to a different manifest name or SHA-256.`,
    );
  }
  const expectedKeys = new Set(manifestCases(manifest, manifestHash).map((item) => item.caseKey));
  const seen = new Set();
  for (const label of parsed.labels) {
    if (!expectedKeys.has(label.caseKey)) {
      throw new Error(`Label submission ${parsed.reviewerId} contains an unknown case key.`);
    }
    if (seen.has(label.caseKey)) {
      throw new Error(`Label submission ${parsed.reviewerId} contains a duplicate case label.`);
    }
    seen.add(label.caseKey);
    for (const path of label.expectedPaths) assertRelativePath(path, label.caseKey);
  }
  if (seen.size !== expectedKeys.size) {
    throw new Error(
      `Label submission ${parsed.reviewerId} is incomplete: ${expectedKeys.size - seen.size} case(s) are missing.`,
    );
  }
  return parsed;
}

/** Validate independent submissions without promoting them to public truth. */
export function verifyLabelSubmissions(manifest, manifestHash, submissions) {
  if (submissions.length < 2) throw new Error('At least two independent label submissions are required.');
  const parsed = submissions.map((submission) =>
    validateSubmission(submission, manifest, manifestHash),
  );
  const reviewers = parsed.map((submission) => submission.reviewerId);
  if (new Set(reviewers).size !== reviewers.length) {
    throw new Error('Independent label submissions must use distinct reviewer identifiers.');
  }
  const byCase = new Map(parsed[0].labels.map((label) => [label.caseKey, [label]]));
  for (const submission of parsed.slice(1)) {
    for (const label of submission.labels) byCase.get(label.caseKey)?.push(label);
  }
  const disagreements = [];
  for (const [key, labels] of byCase) {
    const fingerprints = labels.map((label) =>
      JSON.stringify({
        expectedPaths: stablePaths(label.expectedPaths),
        unknown: label.unknown,
        method: label.method,
      }),
    );
    if (new Set(fingerprints).size !== 1) disagreements.push(key);
  }
  return {
    passed: disagreements.length === 0,
    reviewers,
    caseCount: byCase.size,
    disagreements,
  };
}

/** Merge only unanimous labels; any disagreement fails closed and writes nothing. */
export function mergeLabelSubmissions(manifest, manifestHash, submissions) {
  const verification = verifyLabelSubmissions(manifest, manifestHash, submissions);
  if (!verification.passed) {
    throw new Error(
      `Independent labels disagree for ${verification.disagreements.length} case(s); adjudication is required before merge.`,
    );
  }
  const parsed = submissions.map((submission) =>
    validateSubmission(submission, manifest, manifestHash),
  );
  const labelByKey = new Map(parsed[0].labels.map((label) => [label.caseKey, label]));
  const cases = manifest.cases.map((item) => {
    const key = caseKey(item.repositoryId, item.case.id, manifestHash);
    const label = labelByKey.get(key);
    if (!label) throw new Error(`No merged label exists for ${item.repositoryId}/${item.case.id}.`);
    const reviewerEvidence = parsed.flatMap((submission) => {
      const caseLabel = submission.labels.find((candidate) => candidate.caseKey === key);
      return caseLabel
        ? caseLabel.evidence.map((evidence) => `${submission.reviewerId}: ${evidence}`)
        : [];
    });
    if (reviewerEvidence.length > 20) {
      throw new Error(
        `Merged independent evidence exceeds the manifest limit of 20 entries for ${item.repositoryId}/${item.case.id}.`,
      );
    }
    return {
      ...item,
      case: {
        ...item.case,
        expectedPaths: stablePaths(label.expectedPaths),
        unknown: label.unknown,
        labeling: {
          status: 'independently-verified',
          reviewers: verification.reviewers,
          method: label.method,
          evidence: reviewerEvidence.slice(0, 20),
        },
      },
    };
  });
  return { ...manifest, cases };
}

async function readManifest(manifestPath) {
  const raw = await readFile(manifestPath, 'utf8');
  return {
    raw,
    manifest: parseBenchmarkCorpusManifest(JSON.parse(raw)),
    hash: sha256(raw),
  };
}

async function readSubmission(path) {
  return JSON.parse(await readFile(resolve(path), 'utf8'));
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export function comparablePath(path) {
  const normalized = path.replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function usage() {
  console.error(
    'Usage: node scripts/benchmark/label-kit.mjs <create|verify|merge> --manifest <file> [options]',
  );
  console.error('  create --reviewer <id> [--out <packet.json>]');
  console.error('  verify --labels <reviewer-a.json,reviewer-b.json,...>');
  console.error('  merge --labels <reviewer-a.json,reviewer-b.json,...> --out <manifest.json>');
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const manifestPath = resolve(option(args, '--manifest') ?? 'benchmarks/private-20-repository.manifest.json');
  if (!['create', 'verify', 'merge'].includes(command)) {
    usage();
    process.exitCode = 2;
    return;
  }
  const { manifest, hash } = await readManifest(manifestPath);
  if (command === 'create') {
    const reviewer = option(args, '--reviewer');
    if (!reviewer) throw new Error('create requires --reviewer.');
    const packet = createLabelPacket(manifest, hash, reviewer);
    const out = option(args, '--out');
    if (out) {
      const target = resolve(out);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, `${JSON.stringify(packet, null, 2)}\n`, 'utf8');
      console.log(JSON.stringify({ ok: true, reviewerId: packet.reviewerId, out: target }));
    } else {
      console.log(JSON.stringify(packet, null, 2));
    }
    return;
  }
  const labels = option(args, '--labels')
    ?.split(',')
    .map((path) => path.trim())
    .filter(Boolean);
  if (!labels?.length) throw new Error(`${command} requires --labels with comma-separated files.`);
  const submissions = await Promise.all(labels.map(readSubmission));
  const verification = verifyLabelSubmissions(manifest, hash, submissions);
  if (command === 'verify') {
    console.log(JSON.stringify({ ...verification, manifest: manifest.name, manifestSha256: hash }, null, 2));
    if (!verification.passed) process.exitCode = 1;
    return;
  }
  const out = option(args, '--out');
  if (!out) throw new Error('merge requires --out and refuses in-place manifest replacement.');
  const target = resolve(out);
  if (comparablePath(target) === comparablePath(manifestPath)) {
    throw new Error('merge refuses to overwrite the input manifest.');
  }
  const merged = mergeLabelSubmissions(manifest, hash, submissions);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ ...verification, mergedManifest: target }, null, 2));
}

const currentFile = process.argv[1] ? resolve(process.argv[1]) : '';
if (currentFile === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
