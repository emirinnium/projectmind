import { execFile } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';

const execFileAsync = promisify(execFile);

// Resolve CLI path: try multiple strategies
function getCliPath(): string {
  if (process.env.PROJECTMIND_CLI_PATH) {
    return process.env.PROJECTMIND_CLI_PATH;
  }
  // When running `next dev` from web/, cwd = web/, so CLI is ../dist/cli.js
  return join(process.cwd(), '..', 'dist', 'cli.js');
}

const CLI_PATH = getCliPath();
export const PROJECT_ROOT = join(process.cwd(), '..');

/** Shared loader for the raw report JSON (used by REST route and SSE stream). */
export async function loadReportJson(timeoutMs = 60000): Promise<Record<string, unknown>> {
  const { stdout } = await execFileAsync(
    process.execPath,
    [CLI_PATH, 'report', '--json'],
    {
      cwd: process.cwd(),
      timeout: timeoutMs,
      env: { ...process.env, PROJECTMIND_ROOT: PROJECT_ROOT },
    }
  );

  const jsonStart = stdout.indexOf('{');
  if (jsonStart === -1) {
    throw new Error('No JSON output found in CLI response');
  }
  return JSON.parse(stdout.substring(jsonStart)) as Record<string, unknown>;
}
