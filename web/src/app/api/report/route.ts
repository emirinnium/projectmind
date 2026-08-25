import { execFile } from 'child_process';
import { promisify } from 'util';
import { NextResponse } from 'next/server';
import { join } from 'path';

// execFile with an argv ARRAY: no shell interpolation, no quoting hazards.
const execFileAsync = promisify(execFile);

// Resolve CLI path: try multiple strategies
function getCliPath(): string {
  // Strategy 1: Environment variable (production/CI)
  if (process.env.PROJECTMIND_CLI_PATH) {
    return process.env.PROJECTMIND_CLI_PATH;
  }

  // Strategy 2: Relative to cwd (assumes running from web/ directory)
  // When running `next dev` from web/, cwd = web/, so CLI is ../dist/cli.js
  return join(process.cwd(), '..', 'dist', 'cli.js');
}

const CLI_PATH = getCliPath();
const PROJECT_ROOT = join(process.cwd(), '..');

export async function GET() {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [CLI_PATH, 'report', '--json'],
      {
        cwd: process.cwd(),
        timeout: 60000,
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
      totalFiles: data.totalFiles || 0,
      totalLines: data.totalLines || 0,
      totalBytes: data.totalBytes || 0,
      agentCoverage: data.agentCoverage || 0,
      avgCognitiveLoad: data.avgCognitiveLoad || 0,
      languages: data.languages || {},
      modules: data.modules || [],
      topHotspots: (data.topHotspots || []).map((h: { path: string; cognitiveLoad: number; agentTouched: boolean }) => ({
        path: h.path,
        cognitiveLoad: h.cognitiveLoad,
        agentTouched: h.agentTouched,
      })),
      debtItems: data.debtItems || [],
      debtTotal: data.debtTotal || 0,
      genomeScore: data.genomeScore || 0,
    });
  } catch (error: unknown) {
    const err = error as { message?: string; stdout?: string; stderr?: string };
    return NextResponse.json(
      {
        error: err.message || 'Report failed',
        stdout: err.stdout,
        stderr: err.stderr,
      },
      { status: 500 }
    );
  }
}
