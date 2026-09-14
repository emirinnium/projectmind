import process from 'node:process';
import { collectReviewFindings } from '../../dist/cli/commands/pr-preview-engine.js';
import { DEFAULT_REVIEW_POLICY } from '../../dist/core/review/policy.js';
import { logger } from '../../dist/utils/logger.js';

logger.setMachineMode(true);

const chunks = [];
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  try {
    const payload = JSON.parse(chunks.join(''));
    if (
      !payload ||
      typeof payload.projectRoot !== 'string' ||
      !Array.isArray(payload.changedFiles) ||
      payload.changedFiles.some((file) => typeof file !== 'string')
    ) {
      throw new Error('Review provider worker received an invalid payload.');
    }
    const findings = collectReviewFindings(
      payload.changedFiles,
      payload.projectRoot,
      payload.policy ?? DEFAULT_REVIEW_POLICY,
    );
    process.stdout.write(JSON.stringify({ version: 1, findings }));
  } catch (error) {
    process.stderr.write(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
});
