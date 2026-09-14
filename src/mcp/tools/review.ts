import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from './types.js';
import {
  getChangedFiles,
  getChangedLineRanges,
  collectReviewFindings,
  type ReviewFinding,
} from '@/cli/commands/pr-preview-engine.js';
import { planReviewBundles } from '@/core/review/bundle.js';
import {
  validateFindingPositions,
  reflectFindings,
  verifiedFindings,
} from '@/core/review/finding-validation.js';
import { loadReviewPolicy } from '@/core/review/policy.js';
import { actionableMcpError } from '@/utils/actionable-error.js';
import { asUntrustedContent } from '@/mcp/security/untrusted-content.js';
import { buildReviewGraphClosure } from '@/core/review/graph-closure.js';
import { executeReviewBundles } from '@/core/review/bundle-workers.js';
import { recordReviewDecision } from '@/core/review/audit.js';

function text(payload: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

/** Source-backed review orchestration: policy -> deterministic bundles -> reflection -> publishable findings. */
export function registerReviewProjectTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'review_project',
    {
      title: 'Review Project Changes',
      description:
        'Run a deterministic, policy-driven JS/TS review over a Git diff. Findings are independently position-validated and reflected against current source before they are publishable. Unverified findings remain visible with a reason but are never promoted to SARIF/PR output.',
      inputSchema: {
        base: z.string().trim().min(1).max(256).default('main').describe('Base Git revision'),
        head: z.string().trim().min(1).max(256).default('HEAD').describe('Head Git revision'),
        policyPath: z
          .string()
          .trim()
          .min(1)
          .max(1000)
          .optional()
          .describe('Project-relative review policy JSON'),
        maxBundleBytes: z.number().int().min(1024).max(50_000_000).optional(),
        maxBundleTokens: z.number().int().min(256).max(10_000_000).optional(),
      },
    },
    async (args) => {
      try {
        const policy = loadReviewPolicy(deps.projectRoot, args.policyPath);
        const changedFiles = await getChangedFiles(args.base, args.head, deps.projectRoot);
        const allowedLineRanges = await getChangedLineRanges(
          args.base,
          args.head,
          deps.projectRoot,
          changedFiles,
        );
        const bundles = planReviewBundles(changedFiles, deps.projectRoot, policy, {
          maxBytes: args.maxBundleBytes,
          maxTokens: args.maxBundleTokens,
          allowedLineRanges,
          graphClosure: buildReviewGraphClosure(changedFiles, deps.kg),
        });
        const bundleExecution = await executeReviewBundles(
          bundles.bundles,
          ({ bundle }) =>
            collectReviewFindings(
              bundle.files.map((file) => file.relativePath),
              deps.projectRoot,
              policy,
            ) as ReviewFinding[],
          {
            concurrency: policy.concurrency,
            timeoutMs: policy.bundleTimeoutMs,
            maxRetries: policy.bundleRetries,
          },
        );
        const generated = bundleExecution.results.flatMap((result) => result.value ?? []);
        const positioned = validateFindingPositions(generated, bundles, deps.projectRoot);
        const reflected = reflectFindings(positioned, policy, deps.projectRoot);
        const publishable = verifiedFindings(reflected);
        const complete = bundles.excluded.length === 0 && bundleExecution.complete;
        const audit = recordReviewDecision(deps.db, deps.kg, {
          base: args.base,
          head: args.head,
          policyVersion: String(policy.version),
          changedFiles,
          excludedFiles: bundles.excluded.length,
          generatedFindings: generated.length,
          verifiedFindings: publishable.length,
          complete,
        });
        return text({
          success: true,
          base: args.base,
          head: args.head,
          policy: { version: policy.version, preset: policy.preset, mode: policy.mode },
          changedFiles,
          bundles,
          bundleExecution,
          findings: publishable.map((finding) => ({
            ...finding,
            untrustedContent: asUntrustedContent(
              finding.evidence?.snippet ?? finding.message,
              'source',
              {
                relativePath: finding.file,
                byteStart: undefined,
                byteEnd: undefined,
              },
            ),
          })),
          audit: reflected,
          coverage: {
            generated: generated.length,
            verified: publishable.length,
            excludedFiles: bundles.excluded.length,
            complete,
          },
          ...(audit ? { evidenceAudit: audit } : {}),
          nextAction: complete
            ? 'Review verified evidence before publishing or applying remediation.'
            : 'Resolve excluded files or failed/timed-out bundles and rerun; this result does not claim complete coverage.',
        });
      } catch (error) {
        return actionableMcpError(error);
      }
    },
  );
}
