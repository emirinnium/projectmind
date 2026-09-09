import { Command } from 'commander';
import { asyncHandler, output, withContext } from '@/cli/utils/shared.js';
import { confineToProject } from '@/mcp/tools/_shared.js';
import {
  buildEvidencePacket,
  insufficientEvidencePacket,
  verifyProjectFreshness,
  type EvidenceReference,
  type FreshnessSummary,
  type EvidencePacket,
} from '@/core/proof/evidence.js';

interface ProofOptions {
  format: string;
  maxFiles: string;
  failOnStale?: boolean;
}

function references(summary: FreshnessSummary): EvidenceReference[] {
  return summary.details.map((detail) => ({
    filePath: detail.filePath,
    kind: 'direct-source' as const,
    lineStart: detail.lineCount === undefined ? undefined : 1,
    lineEnd: detail.lineCount,
    sourceHash: detail.sourceHash,
    indexedHash: detail.indexedHash,
    note: `freshness=${detail.status}`,
  }));
}

function printPacket(packet: EvidencePacket): void {
  output.kv('Claim status', packet.claimStatus);
  output.kv('Confidence', `${(packet.confidence * 100).toFixed(0)}%`);
  output.kv('Graph fresh', packet.verification.graphFresh ? 'yes' : 'no');
  output.kv('Source verified', packet.verification.sourceVerified ? 'yes' : 'no');
  output.kv('AST verified', packet.verification.astVerified ? 'yes' : 'no');
  output.kv('Typecheck verified', packet.verification.typecheckVerified ? 'yes' : 'no');
  output.kv('Runtime verified', packet.verification.runtimeVerified ? 'yes' : 'no');

  const freshness = packet.freshness;
  output.section('Freshness');
  output.kv('Checked', freshness.checkedFiles);
  output.kv('Fresh', freshness.freshFiles);
  output.kv('Stale', freshness.staleFiles);
  output.kv('Unindexed', freshness.unindexedFiles);
  output.kv('Missing', freshness.missingFiles);
  output.kv('Unknown', freshness.unknownFiles);

  if (freshness.details.length > 0) {
    output.section('File evidence');
    for (const detail of freshness.details.slice(0, 50)) {
      output.kv(
        `  ${detail.filePath}`,
        `${detail.status}${detail.error ? ` — ${detail.error}` : ''}`,
      );
    }
    if (freshness.details.length > 50) {
      output.info(`  ... and ${freshness.details.length - 50} more files`);
    }
  }

  if (packet.verification.limitations.length > 0) {
    output.section('Limitations');
    for (const limitation of packet.verification.limitations) output.info(`  ${limitation}`);
  }
}

export function createProofCommand(): Command {
  const proof = new Command('proof').description(
    'Verify ProjectMind claims with source evidence and graph freshness checks',
  );

  proof.action(() => {
    proof.outputHelp();
  });

  proof
    .command('verify [files...]')
    .description('Verify selected files or the complete indexed project')
    .option('--format <format>', 'Output: text|json', 'text')
    .option('--max-files <n>', 'Safety cap for project verification', '2000')
    .option('--fail-on-stale', 'Set a non-zero exit code when verification is not complete')
    .action(
      asyncHandler(async (files: string[], options: ProofOptions) => {
        await withContext(async (ctx) => {
          if (!['text', 'json'].includes(options.format)) {
            throw new Error(`--format must be text or json: ${options.format}`);
          }
          const maxFiles = Number.parseInt(options.maxFiles, 10);
          if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > 10000) {
            throw new Error(
              `--max-files must be an integer between 1 and 10000: ${options.maxFiles}`,
            );
          }

          const requested =
            files.length > 0
              ? [
                  ...new Set(
                    files.map((filePath) => confineToProject(filePath, ctx.config.projectRoot)),
                  ),
                ]
              : undefined;
          const candidates =
            requested ?? ctx.kg.getAllFiles().map((file) => file.relativePath || file.path);
          const selected = candidates.slice(0, maxFiles);
          const truncated = candidates.length > selected.length;
          const freshness = await verifyProjectFreshness(ctx.kg, ctx.config.projectRoot, selected);
          const summary: FreshnessSummary = truncated
            ? { ...freshness, status: 'partial' }
            : freshness;
          const packet = buildEvidencePacket(summary, {
            evidence: references(summary),
            // A matching source hash establishes freshness only; it does not
            // prove that the source was parsed successfully as an AST.
            astVerified: false,
            limitations: truncated ? [`Verification was capped at ${maxFiles} files.`] : [],
          });
          const result = {
            success: true,
            scope: requested ? 'selected-files' : 'all-indexed-files',
            packet,
          };

          if (options.format === 'json') {
            output.json(result);
          } else {
            output.section('ProjectMind Proof Verification');
            output.kv('Scope', result.scope);
            printPacket(packet);
          }
          if (options.failOnStale && packet.claimStatus !== 'verified') process.exitCode = 2;
        });
      }),
    );

  proof
    .command('claim <claim>')
    .description('Verify a claim against explicitly supplied source files')
    .option('--files <paths...>', 'Source files expected to support the claim')
    .option('--format <format>', 'Output: text|json', 'text')
    .action(
      asyncHandler(async (claim: string, options: ProofOptions & { files?: string[] }) => {
        await withContext(async (ctx) => {
          if (!['text', 'json'].includes(options.format)) {
            throw new Error(`--format must be text or json: ${options.format}`);
          }

          let packet: EvidencePacket;
          let files: string[] = [];
          if (!options.files || options.files.length === 0) {
            packet = insufficientEvidencePacket(
              'No source locations were provided. A natural-language claim cannot be proven from the claim text alone.',
            );
          } else {
            files = [
              ...new Set(
                options.files.map((filePath) => confineToProject(filePath, ctx.config.projectRoot)),
              ),
            ];
            const freshness = await verifyProjectFreshness(ctx.kg, ctx.config.projectRoot, files);
            packet = buildEvidencePacket(freshness, {
              evidence: references(freshness),
              // Fresh source evidence is deliberately distinct from AST or
              // semantic verification of an arbitrary natural-language claim.
              astVerified: false,
              limitations: [
                'The claim text is retained for traceability; source freshness does not prove arbitrary natural-language semantics.',
              ],
            });
          }

          const result = {
            success: true,
            claim,
            files,
            claimStatus: packet.claimStatus,
            nextAction:
              packet.claimStatus === 'verified'
                ? 'Review the cited evidence and run typecheck/runtime verification where required.'
                : 'Inspect limitations and refresh the graph before relying on the claim.',
            evidence: packet,
          };
          if (options.format === 'json') {
            output.json(result);
          } else {
            output.section('ProjectMind Claim Proof');
            output.kv('Claim', claim);
            printPacket(packet);
            output.kv('Next action', result.nextAction);
          }
        });
      }),
    );

  return proof;
}
