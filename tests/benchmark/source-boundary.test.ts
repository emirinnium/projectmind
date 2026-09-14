import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const projectRoot = process.cwd();

function collectFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? collectFiles(path) : [path];
  });
}

describe('benchmark source boundary', () => {
  it('keeps benchmark implementation in maintainer scripts, outside production source', () => {
    const productionBenchmarkPaths = [
      'src/core/benchmark',
      'src/cli/commands/benchmark.ts',
      'src/cli/commands/benchmark-mcp.ts',
      'src/cli/commands/benchmark-mcp-worker.ts',
    ];
    const scriptBenchmarkPaths = [
      'scripts/benchmark/manifest.mjs',
      'scripts/benchmark/runner.mjs',
      'scripts/benchmark/scoring.mjs',
      'scripts/benchmark/gate.mjs',
      'scripts/benchmark/security.mjs',
      'scripts/benchmark/security-corpus.mjs',
      'scripts/benchmark/security-regression.mjs',
      'scripts/benchmark/check-security-regression.mjs',
      'benchmarks/private-20-repository.security.baseline.md',
      'benchmarks/private-20-repository.security.regression-baseline.json',
      'scripts/benchmark/benchmark-mcp.mjs',
      'scripts/benchmark/product.mjs',
      'scripts/benchmark/regression.mjs',
      'scripts/benchmark/check-regression.mjs',
      'scripts/benchmark/tokenizer.mjs',
      'scripts/benchmark/review-provider-worker.mjs',
      'scripts/benchmark/review-provider.mjs',
      'scripts/benchmark/provider-comparison.mjs',
      'scripts/run-provider-comparison.mjs',
      'scripts/run-private-product-corpus.mjs',
      'scripts/run-private-security-corpus.mjs',
      'benchmarks/private-20-repository.regression-baseline.json',
    ];

    expect(productionBenchmarkPaths.every((path) => !existsSync(join(projectRoot, path)))).toBe(
      true,
    );
    expect(scriptBenchmarkPaths.every((path) => existsSync(join(projectRoot, path)))).toBe(true);

    const productionFiles = collectFiles(join(projectRoot, 'src'));
    expect(productionFiles.some((path) => /(?:^|[\\/])benchmark(?:[\\/]|\.)/iu.test(path))).toBe(
      false,
    );

    const maintainerBenchmarkFiles = collectFiles(join(projectRoot, 'scripts', 'benchmark'));
    expect(maintainerBenchmarkFiles.length).toBeGreaterThan(0);
    expect(maintainerBenchmarkFiles.every((path) => path.endsWith('.mjs'))).toBe(true);

    for (const publicSurface of ['package.json', 'cli.mjs', 'src/cli.ts', 'src/cli/program.ts']) {
      expect(readFileSync(join(projectRoot, publicSurface), 'utf8')).not.toMatch(
        /\bpm\s+benchmark\b/iu,
      );
    }
  });
});
