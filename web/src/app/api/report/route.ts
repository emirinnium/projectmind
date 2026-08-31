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

/** Execute the CLI report command and return raw stdout */
async function fetchReportStdout(): Promise<{ stdout: string; stderr: string }> {
  return await execFileAsync(
    process.execPath,
    [CLI_PATH, 'report', '--json'],
    {
      cwd: process.cwd(),
      timeout: 60000,
      env: { ...process.env, PROJECTMIND_ROOT: PROJECT_ROOT },
    }
  );
}

/** Parse CLI JSON output, finding the JSON object within mixed output */
function parseJsonOutput(stdout: string): any {
  // The CLI may output non-JSON lines (banner, etc.) before the JSON
  const jsonStart = stdout.indexOf('{');
  if (jsonStart === -1) {
    throw new Error('No JSON output found in CLI response');
  }
  const jsonStr = stdout.substring(jsonStart);
  return JSON.parse(jsonStr);
}

/** Build the API response data from parsed CLI report data */
function buildReportResponse(data: any): {
  totalFiles: number;
  totalLines: number;
  totalBytes: number;
  agentCoverage: number;
  avgCognitiveLoad: number;
  languages: Record<string, { files: number; bytes: number }>;
  modules: any[];
  topHotspots: Array<{ path: string; cognitiveLoad: number; agentTouched: boolean }>;
  debtItems: any[];
  debtTotal: number;
  genomeScore: number;
} {
  return {
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
  };
}

export async function GET() {
  try {
    const { stdout, stderr } = await fetchReportStdout();
    const data = parseJsonOutput(stdout);
    const responseData = buildReportResponse(data);

    return NextResponse.json({
      totalFiles: responseData.totalFiles,
      totalLines: responseData.totalLines,
      totalBytes: responseData.totalBytes,
      agentCoverage: responseData.agentCoverage,
      avgCognitiveLoad: responseData.avgCognitiveLoad,
      languages: responseData.languages,
      modules: responseData.modules,
      topHotspots: responseData.topHotspots,
      debtItems: responseData.debtItems,
      debtTotal: responseData.debtTotal,
      genomeScore: responseData.genomeScore,
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
