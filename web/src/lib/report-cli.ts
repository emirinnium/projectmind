import { execFile } from 'child_process';
import { promisify } from 'util';
import { resolveProjectPaths } from './project-paths';

const execFileAsync = promisify(execFile);

const { cliPath: CLI_PATH, projectRoot: PROJECT_ROOT } = resolveProjectPaths();

export interface ScanCliResponse {
  protocolVersion: number;
  scanned: number;
  errors: number;
  totalFiles: number;
  agentCoverage: number;
  avgCognitiveLoad: number;
}

export interface ReportCliResponse {
  protocolVersion: number;
  totalFiles: number;
  totalLines: number;
  totalBytes: number;
  agentCoverage: number;
  avgCognitiveLoad: number;
  languages: Record<string, { files: number; bytes: number }>;
  modules: Array<Record<string, unknown>>;
  topHotspots: Array<{ path: string; cognitiveLoad: number; agentTouched: boolean }>;
  debtItems: Array<Record<string, unknown>>;
  debtTotal: number;
  genomeScore: number;
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`CLI response field '${field}' must be a finite number`);
  }
  return value;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`CLI response field '${field}' must be an object`);
  }
  return value as Record<string, unknown>;
}

function parseProtocol(value: unknown): number {
  const version = finiteNumber(value, 'protocolVersion');
  if (version !== 1) throw new Error(`Unsupported CLI response protocol: ${version}`);
  return version;
}

export function parseScanResponse(value: unknown): ScanCliResponse {
  const data = record(value, 'root');
  return {
    protocolVersion: parseProtocol(data.protocolVersion),
    scanned: finiteNumber(data.scanned, 'scanned'),
    errors: finiteNumber(data.errors, 'errors'),
    totalFiles: finiteNumber(data.totalFiles, 'totalFiles'),
    agentCoverage: finiteNumber(data.agentCoverage, 'agentCoverage'),
    avgCognitiveLoad: finiteNumber(data.avgCognitiveLoad, 'avgCognitiveLoad'),
  };
}

export function parseReportResponse(value: unknown): ReportCliResponse {
  const data = record(value, 'root');
  const hotspots = data.topHotspots;
  if (!Array.isArray(hotspots)) throw new Error("CLI response field 'topHotspots' must be an array");
  const normalizedHotspots = hotspots.map((item, index) => {
    const h = record(item, `topHotspots[${index}]`);
    if (typeof h.path !== 'string' || typeof h.agentTouched !== 'boolean') {
      throw new Error(`Invalid topHotspots[${index}] shape`);
    }
    return {
      path: h.path,
      cognitiveLoad: finiteNumber(h.cognitiveLoad, `topHotspots[${index}].cognitiveLoad`),
      agentTouched: h.agentTouched,
    };
  });
  const languages = record(data.languages, 'languages');
  const modules = data.modules;
  const debtItems = data.debtItems;
  if (!Array.isArray(modules) || !Array.isArray(debtItems)) {
    throw new Error("CLI response fields 'modules' and 'debtItems' must be arrays");
  }
  return {
    protocolVersion: parseProtocol(data.protocolVersion),
    totalFiles: finiteNumber(data.totalFiles, 'totalFiles'),
    totalLines: finiteNumber(data.totalLines, 'totalLines'),
    totalBytes: finiteNumber(data.totalBytes, 'totalBytes'),
    agentCoverage: finiteNumber(data.agentCoverage, 'agentCoverage'),
    avgCognitiveLoad: finiteNumber(data.avgCognitiveLoad, 'avgCognitiveLoad'),
    languages: languages as ReportCliResponse['languages'],
    modules: modules.map((item) => record(item, 'modules[]')),
    topHotspots: normalizedHotspots,
    debtItems: debtItems.map((item) => record(item, 'debtItems[]')),
    debtTotal: finiteNumber(data.debtTotal, 'debtTotal'),
    genomeScore: finiteNumber(data.genomeScore, 'genomeScore'),
  };
}

function parseJsonObject(stdout: string): Record<string, unknown> {
  for (let start = stdout.indexOf('{'); start >= 0; start = stdout.indexOf('{', start + 1)) {
    try {
      const parsed: unknown = JSON.parse(stdout.slice(start));
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try the next object boundary when a preceding log line contains `{`.
    }
  }
  throw new Error('CLI did not return a JSON object');
}

/** Shared loader for the raw report JSON (used by REST route and SSE stream). */
export async function loadReportJson(timeoutMs = 60000): Promise<ReportCliResponse> {
  const { stdout } = await execFileAsync(
    process.execPath,
    [CLI_PATH, 'report', '--json'],
    {
      cwd: process.cwd(),
      timeout: timeoutMs,
      env: { ...process.env, PROJECTMIND_ROOT: PROJECT_ROOT },
    }
  );

  return parseReportResponse(parseJsonObject(stdout));
}

export async function runScanJson(timeoutMs = 120000): Promise<ScanCliResponse> {
  const { stdout } = await execFileAsync(
    process.execPath,
    [CLI_PATH, 'scan', '--full', '--json', '--root', PROJECT_ROOT],
    {
      cwd: process.cwd(),
      timeout: timeoutMs,
      env: { ...process.env, PROJECTMIND_ROOT: PROJECT_ROOT },
    },
  );
  return parseScanResponse(parseJsonObject(stdout));
}
