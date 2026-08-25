import { execFile } from 'child_process';
import { promisify } from 'util';
import { NextResponse } from 'next/server';
import { join } from 'path';

const execFileAsync = promisify(execFile);

// Resolve CLI path: try multiple strategies
function getCliPath(): string {
  // Strategy 1: Environment variable (production/CI)
  if (process.env.PROJECTMIND_CLI_PATH) {
    return process.env.PROJECTMIND_CLI_PATH;
  }

  // Strategy 2: Relative to cwd (assumes running from web/ directory)
  // When running `next dev` from web/, cwd = web/, so CLI is ../dist/cli.js
  const cwdCli = join(process.cwd(), '..', 'dist', 'cli.js');
  return cwdCli;
}

const CLI_PATH = getCliPath();
const PROJECT_ROOT = join(process.cwd(), '..');

export async function POST() {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [CLI_PATH, 'scan', '--full', '--json', '--root', PROJECT_ROOT],
      {
        cwd: process.cwd(),
        timeout: 120000,
        env: { ...process.env, PROJECTMIND_ROOT: PROJECT_ROOT },
      }
    );

    // Parse JSON output - find the JSON object in the output
    // The CLI may output non-JSON lines (banner, etc.) before the JSON
    const jsonStart = stdout.indexOf('{');
    if (jsonStart === -1) {
      throw new Error('No JSON output found in CLI response');
    }
    const jsonStr = stdout.substring(jsonStart);
    const data = JSON.parse(jsonStr);

    return NextResponse.json({
      success: true,
      scanned: data.scanned || 0,
      errors: data.errors || 0,
      totalFiles: data.totalFiles || 0,
      agentCoverage: data.agentCoverage || 0,
      avgCognitiveLoad: data.avgCognitiveLoad || 0,
    });
  } catch (error: unknown) {
    const err = error as { message?: string; stdout?: string; stderr?: string };
    return NextResponse.json(
      {
        error: err.message || 'Scan failed',
        stdout: err.stdout,
        stderr: err.stderr,
      },
      { status: 500 }
    );
  }
}
