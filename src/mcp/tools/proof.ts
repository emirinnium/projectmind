import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from './types.js';
import { confineToProject } from './_shared.js';
import {
  attachEvidence,
  buildEvidencePacket,
  insufficientEvidencePacket,
  verifyProjectFreshness,
  type EvidenceReference,
  type FreshnessSummary,
} from '../../core/proof/evidence.js';

function evidenceReferences(summary: FreshnessSummary): EvidenceReference[] {
  return summary.details.map((detail) => ({
    filePath: detail.filePath,
    kind: 'direct-source' as const,
    lineStart: detail.lineCount === undefined ? undefined : 1,
    lineEnd: detail.lineCount,
    sourceHash: detail.sourceHash,
    indexedHash: detail.indexedHash,
    note:
      detail.status === 'fresh'
        ? 'Source content hash matches the indexed graph hash.'
        : `Freshness status: ${detail.status}.`,
  }));
}

function textResult(payload: object): {
  content: Array<{ type: 'text'; text: string }>;
} {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

/**
 * Prove a claim only against explicitly supplied source files. Natural
 * language is not treated as evidence: without file references this tool
 * returns an honest insufficient-evidence result instead of guessing.
 */
export function registerProveClaimTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'prove_claim',
    {
      title: 'Prove Claim With Evidence',
      description:
        'Verify a claim against exact project source files. This tool never treats semantic similarity or a numeric confidence score as proof. Provide filePaths for source-backed verification; without them the result is explicitly insufficient-evidence.',
      inputSchema: {
        claim: z.string().trim().min(1).max(4000).describe('Claim that needs verification'),
        filePaths: z
          .array(z.string().trim().min(1).max(1000))
          .max(200)
          .optional()
          .describe('Source files that are expected to support the claim'),
      },
    },
    async (args) => {
      try {
        if (!args.filePaths || args.filePaths.length === 0) {
          return textResult({
            success: true,
            claim: args.claim,
            claimStatus: 'insufficient-evidence',
            nextAction: 'Provide one or more exact filePaths and run prove_claim again.',
            evidence: insufficientEvidencePacket(
              'No source locations were provided. A natural-language claim cannot be proven from the claim text alone.',
            ),
          });
        }

        const paths = [
          ...new Set(
            args.filePaths.map((filePath) => confineToProject(filePath, deps.projectRoot)),
          ),
        ];
        const freshness = await verifyProjectFreshness(deps.kg, deps.projectRoot, paths);
        const packet = buildEvidencePacket(freshness, {
          evidence: evidenceReferences(freshness),
          // Hash freshness is not AST parsing. Keep the AST claim false until
          // a parser/type-service evidence source is actually attached.
          astVerified: false,
          limitations: [
            'The claim text is retained for traceability; this tool verifies source freshness, not arbitrary natural-language semantics.',
          ],
        });
        // A fresh source is evidence that the cited files are current; it is
        // not a semantic proof of an arbitrary natural-language claim. Keep
        // those two facts separate so callers cannot mistake hash freshness
        // for a completed semantic review.
        const claimStatus =
          packet.claimStatus === 'verified' ? 'source-backed' : packet.claimStatus;
        return textResult(
          attachEvidence(
            {
              success: true,
              claim: args.claim,
              claimStatus,
              claimScope: 'source-freshness-only',
              nextAction:
                packet.claimStatus === 'verified'
                  ? 'Use the cited source locations and graph evidence; typecheck/runtime behavior still require separate verification.'
                  : 'Inspect the cited limitations and run scan_project before relying on this claim.',
            },
            packet,
          ),
        );
      } catch (error) {
        return textResult({
          success: false,
          error: error instanceof Error ? error.message : String(error),
          claimStatus: 'unverified',
          nextAction: 'Correct the file paths and retry; no claim was accepted.',
        });
      }
    },
  );
}

/** Verify that the indexed graph still matches the current source tree. */
export function registerVerifyFreshnessTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'verify_freshness',
    {
      title: 'Verify Graph Freshness',
      description:
        'Compare current source hashes with ProjectMind graph hashes. Returns per-file fresh/stale/unindexed/missing states and actionable limitations; it never silently treats unreadable files as current.',
      inputSchema: {
        filePaths: z
          .array(z.string().trim().min(1).max(1000))
          .max(2000)
          .optional()
          .describe('Specific files to verify; omitted means all indexed project files'),
        maxFiles: z
          .number()
          .int()
          .min(1)
          .max(10000)
          .default(2000)
          .describe('Safety cap for a full-project verification'),
      },
    },
    async (args) => {
      try {
        const requested = args.filePaths
          ? [
              ...new Set(
                args.filePaths.map((filePath) => confineToProject(filePath, deps.projectRoot)),
              ),
            ]
          : undefined;
        const candidates =
          requested ?? deps.kg.getAllFiles().map((file) => file.relativePath || file.path);
        const selected = candidates.slice(0, args.maxFiles);
        const truncated = candidates.length > selected.length;
        const freshness = await verifyProjectFreshness(deps.kg, deps.projectRoot, selected);
        const summary: FreshnessSummary = truncated
          ? {
              ...freshness,
              status: 'partial',
            }
          : freshness;
        const packet = buildEvidencePacket(summary, {
          evidence: evidenceReferences(summary),
          // This tool checks source/index hashes only; it does not parse ASTs.
          astVerified: false,
          limitations: truncated
            ? [
                `Verification was capped at ${args.maxFiles} files; not all requested files were checked.`,
              ]
            : [],
        });
        return textResult(
          attachEvidence(
            {
              success: true,
              scope: requested ? 'selected-files' : 'all-indexed-files',
              checkedFiles: summary.checkedFiles,
              nextAction:
                summary.status === 'verified'
                  ? 'Graph hashes match the checked source files. Run this again after edits.'
                  : 'Run scan_project to refresh stale or unindexed graph entries before trusting analysis.',
            },
            packet,
          ),
        );
      } catch (error) {
        return textResult({
          success: false,
          error: error instanceof Error ? error.message : String(error),
          nextAction: 'No freshness conclusion was accepted.',
        });
      }
    },
  );
}
