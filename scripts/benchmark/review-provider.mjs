import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertProjectPath } from '../../dist/core/security/path-security.js';
import {
  createContextTokenCounter,
  estimateContextTokens,
} from '../../dist/core/context/tokenizer.js';
import { DEFAULT_REVIEW_POLICY } from '../../dist/core/review/policy.js';
import { planReviewBundles } from '../../dist/core/review/bundle.js';
import {
  reflectFindings,
  validateFindingPositions,
  verifiedFindings,
} from '../../dist/core/review/finding-validation.js';

const WORKER_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 30_000;

function normalizeTimeout(value) {
  const timeout = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1_000 || timeout > 300_000) {
    throw new Error('Isolated review provider timeout must be an integer between 1000 and 300000.');
  }
  return timeout;
}

function outputBytes(value) {
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
}

function normalizeRelativePath(value) {
  return value.replace(/\\/g, '/').replace(/^\.\//u, '');
}

function safeMarkdown(value) {
  return String(value)
    .replace(/[|\r\n]+/gu, ' ')
    .trim();
}

function levelForSeverity(severity) {
  return severity === 'high' ? 'error' : severity === 'medium' ? 'warning' : 'note';
}

function sanitizedFinding(finding) {
  return {
    fingerprint: finding.fingerprint,
    rule: finding.rule,
    severity: finding.severity,
    file: finding.file,
    line: finding.line,
    ...(finding.column === undefined ? {} : { column: finding.column }),
    message: finding.message,
    ...(finding.confidence === undefined ? {} : { confidence: finding.confidence }),
    status: finding.status,
    ...(finding.evidence
      ? { evidence: { sourceHash: finding.evidence.sourceHash, line: finding.evidence.line } }
      : {}),
    nextAction: finding.nextAction,
  };
}

function runWorker(payload, timeoutMs, projectRoot) {
  const workerPath = fileURLToPath(new URL('./review-provider-worker.mjs', import.meta.url));
  const child = spawn(process.execPath, [workerPath], {
    cwd: projectRoot,
    env: { ...process.env, PROJECTMIND_MACHINE: '1' },
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));

  return new Promise((resolveResult, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      if (!settled) {
        settled = true;
        reject(new Error(`Isolated review provider timed out after ${timeoutMs} ms.`));
      }
    }, timeoutMs);
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    child.once('error', (error) => finish(() => reject(error)));
    child.once('close', (code) => {
      finish(() => {
        const diagnostic = Buffer.concat(stderr).toString('utf8').trim();
        if (code !== 0) {
          reject(new Error(diagnostic || `Isolated review provider exited with code ${code}.`));
          return;
        }
        try {
          resolveResult(JSON.parse(Buffer.concat(stdout).toString('utf8')));
        } catch (error) {
          reject(
            new Error(
              `Isolated review provider returned invalid JSON${diagnostic ? `: ${diagnostic}` : '.'}`,
            ),
          );
          void error;
        }
      });
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

/**
 * Execute the deterministic reviewer fixture in a disposable process per
 * review bundle. This is a maintainer benchmark, not a production reviewer or
 * a public CLI command.
 */
export async function runIsolatedReviewProviderBenchmark(options = {}) {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const changedFiles = [...new Set(options.changedFiles ?? [])].map((file) =>
    file.replace(/\\/g, '/'),
  );
  const policy = options.policy ?? DEFAULT_REVIEW_POLICY;
  const timeoutMs = normalizeTimeout(options.timeoutMs);
  const tokenizer = await createContextTokenCounter({
    mode: options.tokenizerMode ?? 'heuristic',
    model: options.tokenizerModel,
  });

  for (const file of changedFiles) {
    assertProjectPath(file, projectRoot, { mustExist: true, rejectIgnored: true });
  }

  const plan = planReviewBundles(changedFiles, projectRoot, policy, options.bundleOptions);
  const started = performance.now();
  const bundleResults = [];
  const allFindings = [];

  for (const bundle of plan.bundles) {
    const bundleStarted = performance.now();
    try {
      const workerResult = await runWorker(
        {
          projectRoot,
          changedFiles: bundle.files.map((file) => file.relativePath),
          policy,
        },
        timeoutMs,
        projectRoot,
      );
      const findings = Array.isArray(workerResult.findings) ? workerResult.findings : [];
      allFindings.push(...findings);
      let resolvedProviderInputTokens = 0;
      for (const file of bundle.files) {
        const absolutePath = assertProjectPath(file.relativePath, projectRoot, {
          mustExist: true,
          rejectIgnored: true,
        });
        resolvedProviderInputTokens += await tokenizer.count(readFileSync(absolutePath, 'utf8'));
      }
      const serializedFindings = JSON.stringify(findings);
      bundleResults.push({
        bundleId: bundle.id,
        status: 'completed',
        durationMs: Math.max(0, Math.round(performance.now() - bundleStarted)),
        inputBytes: bundle.estimatedBytes,
        inputTokens: bundle.estimatedTokens,
        providerInputTokens: resolvedProviderInputTokens,
        outputBytes: outputBytes(findings),
        outputTokens: Math.ceil(outputBytes(findings) / 4),
        providerOutputTokens: await tokenizer.count(serializedFindings),
        findingCount: findings.length,
      });
    } catch (error) {
      bundleResults.push({
        bundleId: bundle.id,
        status: 'failed',
        durationMs: Math.max(0, Math.round(performance.now() - bundleStarted)),
        inputBytes: bundle.estimatedBytes,
        inputTokens: bundle.estimatedTokens,
        outputBytes: 0,
        outputTokens: 0,
        providerInputTokens: 0,
        providerOutputTokens: 0,
        findingCount: 0,
        error:
          error instanceof Error
            ? error.message.replace(/[\r\n\t]+/g, ' ').slice(0, 500)
            : String(error),
      });
    }
  }

  const validated = validateFindingPositions(allFindings, plan, projectRoot);
  const reflected = reflectFindings(validated, policy, projectRoot);
  const verified = verifiedFindings(reflected);
  const inputHash = createHash('sha256')
    .update(
      JSON.stringify({
        workerVersion: WORKER_VERSION,
        planInputHash: plan.inputHash,
        policy: { version: policy.version, preset: policy.preset },
        tokenizer: { mode: tokenizer.mode, model: tokenizer.model },
        bundles: bundleResults.map((bundle) => ({
          bundleId: bundle.bundleId,
          status: bundle.status,
          findingCount: bundle.findingCount,
          error: bundle.error ?? null,
        })),
        findings: reflected.map((finding) => ({
          fingerprint: finding.fingerprint,
          file: finding.file,
          line: finding.line,
          rule: finding.rule,
          status: finding.status,
        })),
      }),
    )
    .digest('hex');

  return {
    provider: {
      name: 'projectmind-deterministic-review-fixture',
      version: WORKER_VERSION,
      processIsolated: true,
    },
    tokenizer: {
      mode: tokenizer.mode,
      model: tokenizer.model,
      limitations: [...tokenizer.limitations],
    },
    inputHash,
    bundles: bundleResults,
    excluded: plan.excluded,
    generatedFindings: allFindings.length,
    verifiedFindings: verified.length,
    complete:
      bundleResults.every((bundle) => bundle.status === 'completed') &&
      plan.excluded.length === 0 &&
      reflected.every((finding) => finding.status === 'verified'),
    findings: reflected.map(sanitizedFinding),
    durationMs: Math.max(0, Math.round(performance.now() - started)),
    limitations: [
      'The process-isolated provider is deterministic fixture logic, not an external model quality measurement.',
      'Provider tokenizer counts cover changed-source and serialized-finding text only; provider billing and reviewer prompt overhead are not included.',
      'Finding quality is limited to the configured local review rules and is still validated by the production position/reflection gate.',
    ],
  };
}

/** Render only verified findings as line-level SARIF review evidence. */
export function renderIsolatedReviewBenchmarkSarif(result) {
  const rules = [
    ...new Map(
      result.findings.map((finding) => [
        finding.rule,
        {
          id: finding.rule,
          shortDescription: { text: `ProjectMind review rule ${finding.rule}` },
          helpUri: 'https://github.com/emirinnium/projectmind',
        },
      ]),
    ).values(),
  ];
  const results = result.findings
    .filter((finding) => finding.status === 'verified')
    .map((finding) => ({
      ruleId: finding.rule,
      level: levelForSeverity(finding.severity),
      message: { text: finding.message },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: normalizeRelativePath(finding.file) },
            region: {
              startLine: finding.line,
              ...(finding.column === undefined ? {} : { startColumn: finding.column }),
            },
          },
        },
      ],
      fingerprints: { projectmind: finding.fingerprint },
      properties: {
        benchmark: 'projectmind-isolated-review-fixture',
        status: finding.status,
        sourceHash: finding.evidence?.sourceHash,
      },
    }));
  return JSON.stringify(
    {
      $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
      version: '2.1.0',
      runs: [
        {
          tool: {
            driver: {
              name: 'ProjectMind isolated review fixture',
              version: String(result.provider.version),
              informationUri: 'https://github.com/emirinnium/projectmind',
              rules,
            },
          },
          properties: {
            inputHash: result.inputHash,
            processIsolated: result.provider.processIsolated,
            verifiedFindings: result.verifiedFindings,
            generatedFindings: result.generatedFindings,
            tokenizerMode: result.tokenizer.mode,
          },
          results,
        },
      ],
    },
    null,
    2,
  );
}

/** Render the isolated review fixture without source snippets or secrets. */
export function renderIsolatedReviewBenchmarkMarkdown(result) {
  const lines = [
    '# ProjectMind isolated review benchmark',
    '',
    `- Provider: ${result.provider.name} v${result.provider.version}`,
    `- Process isolated: ${result.provider.processIsolated ? 'yes' : 'no'}`,
    `- Complete: ${result.complete ? 'yes' : 'no'}`,
    `- Input hash: \`${result.inputHash}\``,
    `- Tokenizer: ${result.tokenizer.mode}${result.tokenizer.model ? ` (${result.tokenizer.model})` : ''}`,
    `- Generated findings: ${result.generatedFindings}`,
    `- Verified findings: ${result.verifiedFindings}`,
    `- Duration: ${result.durationMs} ms`,
    '',
    '| Bundle | Status | Duration | Estimated input tokens | Provider input tokens | Provider output tokens | Findings |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: |',
    ...result.bundles.map(
      (bundle) =>
        `| ${safeMarkdown(bundle.bundleId)} | ${safeMarkdown(bundle.status)} | ${bundle.durationMs} ms | ${bundle.inputTokens} | ${bundle.providerInputTokens} | ${bundle.providerOutputTokens} | ${bundle.findingCount} |`,
    ),
  ];
  if (result.findings.length > 0) {
    lines.push(
      '',
      '## Findings',
      '',
      '| File | Line | Rule | Severity | Status | Message |',
      '| --- | ---: | --- | --- | --- | --- |',
      ...result.findings.map(
        (finding) =>
          `| ${safeMarkdown(finding.file)} | ${finding.line} | ${safeMarkdown(finding.rule)} | ${safeMarkdown(finding.severity)} | ${safeMarkdown(finding.status)} | ${safeMarkdown(finding.message)} |`,
      ),
    );
  }
  if (result.excluded.length > 0) {
    lines.push(
      '',
      '## Excluded files',
      '',
      ...result.excluded.map((item) => `- ${safeMarkdown(item)}`),
    );
  }
  lines.push(
    '',
    '## Limitations',
    '',
    ...result.limitations.map((limitation) => `- ${safeMarkdown(limitation)}`),
  );
  return `${lines.join('\n')}\n`;
}
