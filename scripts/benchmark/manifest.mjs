import { z } from 'zod';
export const BenchmarkLabelingSchema = z
  .object({
    status: z.enum(['pending', 'single-reviewer', 'independently-verified']),
    reviewers: z.array(z.string().trim().min(1).max(100)).max(5),
    method: z.enum(['source-inspection', 'test-backed', 'runtime-trace', 'unknown']),
    evidence: z.array(z.string().trim().min(1).max(1000)).max(20),
  })
  .strict()
  .superRefine((labeling, context) => {
    const uniqueReviewers = new Set(labeling.reviewers);
    if (uniqueReviewers.size !== labeling.reviewers.length) {
      context.addIssue({
        code: 'custom',
        path: ['reviewers'],
        message: 'Benchmark labeling reviewers must be unique.',
      });
    }
    if (labeling.status === 'single-reviewer' && labeling.reviewers.length < 1) {
      context.addIssue({
        code: 'custom',
        path: ['reviewers'],
        message: 'Single-reviewer labels require one reviewer identifier.',
      });
    }
    if (labeling.status === 'independently-verified' && labeling.reviewers.length < 2) {
      context.addIssue({
        code: 'custom',
        path: ['reviewers'],
        message: 'Independent labels require at least two distinct reviewers.',
      });
    }
  });
export const BenchmarkCaseSchema = z
  .object({
    id: z.string().min(1).max(200),
    query: z.string().min(1).max(2000),
    expectedPaths: z.array(z.string().min(1)).max(100),
    aliases: z.array(z.string().min(1)).max(100).default([]),
    unknown: z.boolean().default(false),
    kind: z.enum(['search', 'impact', 'dead-code', 'review']).default('search'),
    targetPath: z.string().min(1).max(2000).optional(),
    changedPaths: z.array(z.string().min(1).max(2000)).max(100).optional(),
    labeling: BenchmarkLabelingSchema.optional(),
  })
  .strict();
export const BenchmarkManifestSchema = z
  .object({
    version: z.literal(1),
    name: z.string().min(1).max(200),
    license: z.string().min(1).max(200),
    access: z.enum(['public', 'fixture', 'private']),
    seed: z
      .number()
      .int()
      .min(0)
      .max(2 ** 31 - 1)
      .default(0),
    cases: z.array(BenchmarkCaseSchema).min(1).max(10_000),
  })
  .strict();
export const BenchmarkRepositorySchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
    url: z.string().url(),
    commitSha: z.string().regex(/^[a-f0-9]{40}$/i),
    license: z.string().min(1).max(200),
    languages: z
      .array(z.enum(['javascript', 'typescript', 'jsx', 'tsx']))
      .min(1)
      .max(4),
    fileCount: z.number().int().nonnegative().optional(),
    loc: z.number().int().nonnegative().optional(),
    graphNodes: z.number().int().nonnegative().optional(),
    graphEdges: z.number().int().nonnegative().optional(),
    ignoreFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/i)
      .optional(),
  })
  .strict();
export const BenchmarkCorpusCaseSchema = z
  .object({
    repositoryId: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
    case: BenchmarkCaseSchema,
  })
  .strict();
export const BenchmarkCorpusManifestSchema = z
  .object({
    version: z.literal(1),
    name: z.string().min(1).max(200),
    access: z.enum(['public', 'fixture', 'private']),
    repositories: z.array(BenchmarkRepositorySchema).min(1).max(50),
    cases: z.array(BenchmarkCorpusCaseSchema).min(1).max(10_000),
  })
  .strict();
export function parseBenchmarkManifest(raw) {
  return BenchmarkManifestSchema.parse(raw);
}
export function parseBenchmarkCorpusManifest(raw) {
  const parsed = BenchmarkCorpusManifestSchema.parse(raw);
  const repositoryIdList = parsed.repositories.map((repository) => repository.id);
  if (new Set(repositoryIdList).size !== repositoryIdList.length) {
    throw new Error('Benchmark corpus repository IDs must be unique.');
  }
  const repositoryIds = new Set(parsed.repositories.map((repository) => repository.id));
  const caseIds = new Set();
  const missing = parsed.cases.find((item) => !repositoryIds.has(item.repositoryId));
  if (missing) {
    throw new Error(
      `Benchmark corpus case ${missing.case.id} references unknown repository ${missing.repositoryId}.`,
    );
  }
  for (const item of parsed.cases) {
    const caseKey = `${item.repositoryId}\0${item.case.id}`;
    if (caseIds.has(caseKey)) {
      throw new Error(
        `Benchmark corpus case IDs must be unique within a repository: ${item.repositoryId}/${item.case.id}.`,
      );
    }
    caseIds.add(caseKey);
    for (const expectedPath of item.case.expectedPaths) {
      assertBenchmarkRelativePath(expectedPath, `${item.repositoryId}/${item.case.id}`);
    }
    if (item.case.targetPath) {
      assertBenchmarkRelativePath(item.case.targetPath, `${item.repositoryId}/${item.case.id}`);
    }
    for (const changedPath of item.case.changedPaths ?? []) {
      assertBenchmarkRelativePath(changedPath, `${item.repositoryId}/${item.case.id}`);
    }
  }
  return parsed;
}
/** Manifest paths are repository-relative metadata, never host filesystem paths. */
function assertBenchmarkRelativePath(path, caseId) {
  const normalized = path.replace(/\\/g, '/');
  if (
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split('/').some((segment) => segment === '..')
  ) {
    throw new Error(`Benchmark case ${caseId} contains an unsafe expected path: ${path}.`);
  }
}
