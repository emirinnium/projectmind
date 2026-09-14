import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseBenchmarkCorpusManifest } from './manifest.mjs';
import { runSecurityPatternBenchmark } from './security.mjs';

function repositoryCommit(checkoutPath) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: checkoutPath,
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function addSeverityTotals(total, values) {
  total.critical += values.critical;
  total.high += values.high;
  total.medium += values.medium;
}

/**
 * Run the internal static security candidate evaluator over a metadata-first
 * corpus. No source is copied into ProjectMind or included in the output.
 */
export function runSecurityCorpusBenchmark(manifest, repositoryRoots, options = {}) {
  const validatedManifest = parseBenchmarkCorpusManifest(manifest);
  const verifyCommits = options.verifyCommits ?? true;
  const repositoryResults = [];
  const limitations = new Set();
  const totals = { critical: 0, high: 0, medium: 0 };
  let filesScanned = 0;
  let filesSkipped = 0;

  for (const repository of validatedManifest.repositories) {
    const checkoutPath = repositoryRoots[repository.id]
      ? resolve(repositoryRoots[repository.id])
      : undefined;
    const base = {
      repositoryId: repository.id,
      checkoutPath: checkoutPath ?? '',
      expectedCommit: repository.commitSha,
      actualCommit: null,
      commitVerified: false,
      result: null,
      limitations: [],
    };

    if (!checkoutPath || !existsSync(checkoutPath) || !statSync(checkoutPath).isDirectory()) {
      const message = `Repository ${repository.id} checkout is missing; security evaluation skipped.`;
      base.limitations.push(message);
      limitations.add(message);
      repositoryResults.push(base);
      continue;
    }

    if (verifyCommits) {
      base.actualCommit = repositoryCommit(checkoutPath);
      if (
        !base.actualCommit ||
        base.actualCommit.toLowerCase() !== repository.commitSha.toLowerCase()
      ) {
        const message = base.actualCommit
          ? `Repository ${repository.id} checkout is at ${base.actualCommit}, expected immutable commit ${repository.commitSha}; security evaluation skipped.`
          : `Repository ${repository.id} is not a readable Git checkout; security evaluation skipped.`;
        base.limitations.push(message);
        limitations.add(message);
        repositoryResults.push(base);
        continue;
      }
      base.commitVerified = true;
    }

    const result = runSecurityPatternBenchmark(checkoutPath, {
      includeTests: options.includeTests ?? false,
    });
    base.result = result;
    base.limitations = result.limitations;
    filesScanned += result.filesScanned;
    filesSkipped += result.filesSkipped;
    addSeverityTotals(totals, result.bySeverity);
    for (const message of result.limitations) limitations.add(message);
    repositoryResults.push(base);
  }

  const inputHash = createHash('sha256')
    .update(
      JSON.stringify({
        manifest: validatedManifest,
        includeTests: options.includeTests ?? false,
        repositories: repositoryResults.map((repository) => ({
          repositoryId: repository.repositoryId,
          expectedCommit: repository.expectedCommit,
          actualCommit: repository.actualCommit,
          commitVerified: repository.commitVerified,
          inputHash: repository.result?.inputHash ?? null,
          filesScanned: repository.result?.filesScanned ?? 0,
          filesSkipped: repository.result?.filesSkipped ?? 0,
          bySeverity: repository.result?.bySeverity ?? null,
        })),
      }),
    )
    .digest('hex');

  return {
    benchmark: 'projectmind-security-corpus',
    version: 1,
    manifest: {
      name: validatedManifest.name,
      version: validatedManifest.version,
      access: validatedManifest.access,
      repositories: validatedManifest.repositories.length,
      inputHash,
    },
    repositories: repositoryResults,
    filesScanned,
    filesSkipped,
    bySeverity: totals,
    candidateFindings: totals.critical + totals.high + totals.medium,
    limitations: [...limitations],
  };
}

/** Render corpus security candidates without making vulnerability claims. */
export function renderSecurityCorpusBenchmarkMarkdown(result) {
  const lines = [
    `# ProjectMind security corpus benchmark — ${result.manifest.name}`,
    '',
    `- Input hash: \`${result.manifest.inputHash}\``,
    `- Repositories: ${result.manifest.repositories}`,
    `- Files scanned: ${result.filesScanned}`,
    `- Files skipped: ${result.filesSkipped}`,
    `- Candidate findings: ${result.candidateFindings}`,
    '',
    '| Severity | Candidate count |',
    '| --- | ---: |',
    `| Critical | ${result.bySeverity.critical} |`,
    `| High | ${result.bySeverity.high} |`,
    `| Medium | ${result.bySeverity.medium} |`,
    '',
    '| Repository | Commit verified | Files scanned | Candidates |',
    '| --- | :---: | ---: | ---: |',
  ];
  for (const repository of result.repositories) {
    lines.push(
      `| ${repository.repositoryId} | ${repository.commitVerified ? 'yes' : 'no'} | ${repository.result?.filesScanned ?? 0} | ${repository.result?.findings.length ?? 0} |`,
    );
  }
  if (result.limitations.length > 0) {
    lines.push('', '## Limitations', '', ...result.limitations.map((item) => `- ${item}`));
  }
  lines.push('', '> Candidate counts are static pattern matches, not vulnerability counts.');
  return `${lines.join('\n')}\n`;
}
