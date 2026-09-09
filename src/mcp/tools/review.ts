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
import { toActionableError } from '@/utils/actionable-error.js';
import { asUntrustedContent } from '@/mcp/security/untrusted-content.js';

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
        });
        const generated = collectReviewFindings(
          changedFiles,
          deps.projectRoot,
          policy,
        ) as ReviewFinding[];
        const positioned = validateFindingPositions(generated, bundles, deps.projectRoot);
        const reflected = reflectFindings(positioned, policy, deps.projectRoot);
        const publishable = verifiedFindings(reflected);
        return text({
          success: true,
          base: args.base,
          head: args.head,
          policy: { version: policy.version, preset: policy.preset, mode: policy.mode },
          changedFiles,
          bundles,
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
            complete: bundles.excluded.length === 0,
          },
          nextAction:
            bundles.excluded.length === 0
              ? 'Review verified evidence before publishing or applying remediation.'
              : 'Resolve excluded files and rerun; this result does not claim complete coverage.',
        });
      } catch (error) {
        return text({
          success: false,
          error: toActionableError(error),
          nextAction: 'Check Git revisions and review policy, then rerun review_project.',
        });
      }
    },
  );
}
