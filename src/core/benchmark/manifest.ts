import { z } from 'zod';

export const BenchmarkCaseSchema = z
  .object({
    id: z.string().min(1).max(200),
    query: z.string().min(1).max(2000),
    expectedPaths: z.array(z.string().min(1)).max(100),
    aliases: z.array(z.string().min(1)).max(100).default([]),
    unknown: z.boolean().default(false),
    kind: z.enum(['search', 'impact', 'dead-code', 'review']).default('search'),
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

export type BenchmarkCase = z.infer<typeof BenchmarkCaseSchema>;
export type BenchmarkManifest = z.infer<typeof BenchmarkManifestSchema>;

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

export type BenchmarkRepository = z.infer<typeof BenchmarkRepositorySchema>;
export type BenchmarkCorpusCase = z.infer<typeof BenchmarkCorpusCaseSchema>;
export type BenchmarkCorpusManifest = z.infer<typeof BenchmarkCorpusManifestSchema>;

export function parseBenchmarkManifest(raw: unknown): BenchmarkManifest {
  return BenchmarkManifestSchema.parse(raw);
}

export function parseBenchmarkCorpusManifest(raw: unknown): BenchmarkCorpusManifest {
  const parsed = BenchmarkCorpusManifestSchema.parse(raw);
  const repositoryIds = new Set(parsed.repositories.map((repository) => repository.id));
  const missing = parsed.cases.find((item) => !repositoryIds.has(item.repositoryId));
  if (missing) {
    throw new Error(
      `Benchmark corpus case ${missing.case.id} references unknown repository ${missing.repositoryId}.`,
    );
  }
  return parsed;
}
