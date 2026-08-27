import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SQLOutputValue } from 'node:sqlite';
import { getStatement } from '../../../storage/database.js';
import { KnowledgeGraph, FileInfo } from '../../../storage/knowledge-graph.js';
import { loadConfig } from '../../../utils/config.js';
import type { ModuleInfo, ScaleReport, AgentProfile, ScanProfile } from './types.js';

/**
 * Handles scale reporting and metrics computation
 */
export class ScaleReporter {
  private kg: KnowledgeGraph;

  constructor(kg: KnowledgeGraph) {
    this.kg = kg;
  }

  getScaleReport(): ScaleReport {
    const allFiles = this.kg.getAllFiles();

    const languages: Record<string, { files: number; bytes: number }> = {};
    const modules = new Map<string, ModuleInfo>();
    let totalLines = 0;
    let totalBytes = 0;
    let totalCognitiveLoad = 0;

    for (const file of allFiles) {
      const lang = file.language || 'unknown';
      if (!languages[lang]) {
        languages[lang] = { files: 0, bytes: 0 };
      }
      languages[lang].files++;
      languages[lang].bytes += file.sizeBytes;
      totalBytes += file.sizeBytes;
      totalCognitiveLoad += file.cognitiveLoad;

      const modPath = dirname(file.relativePath).split(/[/\\]/)[0] || '.';
      let mod = modules.get(modPath);
      if (!mod) {
        mod = {
          path: modPath,
          name: modPath,
          fileCount: 0,
          totalBytes: 0,
          cognitiveLoad: 0,
          agentCoverage: 0,
          files: [],
        };
        modules.set(modPath, mod);
      }
      mod.fileCount++;
      mod.totalBytes += file.sizeBytes;
      mod.cognitiveLoad += file.cognitiveLoad;
      mod.files.push(file);

      totalLines += Math.round(file.sizeBytes / 20);
    }

    for (const mod of modules.values()) {
      mod.agentCoverage =
        mod.files.filter((f) => f.agentTouched).length / Math.max(mod.files.length, 1);
    }

    const agentTouched = allFiles.filter((f) => f.agentTouched).length;
    const agentCoverage = allFiles.length > 0 ? agentTouched / allFiles.length : 0;

    const topHotspots = [...allFiles]
      .sort((a, b) => b.cognitiveLoad - a.cognitiveLoad)
      .slice(0, 10);

    const uncovered = allFiles
      .filter((f) => !f.agentTouched)
      .sort((a, b) => b.cognitiveLoad - a.cognitiveLoad)
      .slice(0, 10);

    return {
      totalFiles: allFiles.length,
      totalBytes,
      totalLines,
      languages,
      modules: [...modules.values()],
      agentCoverage,
      avgCognitiveLoad: totalCognitiveLoad / Math.max(allFiles.length, 1),
      topHotspots,
      uncoveredFiles: uncovered,
    };
  }

  storeScanProfile(profile: ScanProfile): void {
    getStatement(
      `INSERT INTO scan_profiles (total_files, scanned_files, error_files, duration_ms, files_per_second, memory_used_mb, errors)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      profile.totalFiles,
      profile.scannedFiles,
      profile.errorFiles,
      profile.durationMs,
      profile.filesPerSecond,
      profile.memoryUsedMB,
      profile.errors.length > 0 ? JSON.stringify(profile.errors) : null
    );
  }

  getLastScanProfile(): ScanProfile | null {
    const row = getStatement(
      `SELECT * FROM scan_profiles ORDER BY created_at DESC LIMIT 1`
    ).get() as Record<string, SQLOutputValue> | undefined;
    
    if (!row) return null;
    
    return {
      totalFiles: row.total_files as number,
      scannedFiles: row.scanned_files as number,
      errorFiles: row.error_files as number,
      durationMs: row.duration_ms as number,
      filesPerSecond: row.files_per_second as number,
      memoryUsedMB: row.memory_used_mb as number,
      errors: row.errors ? JSON.parse(row.errors as string) : [],
      createdAt: row.created_at as string,
    };
  }

  getModuleInfo(modulePath: string): ModuleInfo | null {
    const files = this.kg.getAllFiles();
    const moduleFiles = files.filter((f) => f.relativePath.startsWith(modulePath));
    if (moduleFiles.length === 0) return null;

    const agentTouched = moduleFiles.filter((f) => f.agentTouched).length;
    return {
      path: modulePath,
      name: modulePath,
      fileCount: moduleFiles.length,
      totalBytes: moduleFiles.reduce((s: number, f: FileInfo) => s + f.sizeBytes, 0),
      cognitiveLoad: moduleFiles.reduce((s: number, f: FileInfo) => s + f.cognitiveLoad, 0),
      agentCoverage: agentTouched / moduleFiles.length,
      files: moduleFiles,
    };
  }

  getAgentProfiles(): AgentProfile[] {
    const sessions = this.kg.getAgentSessions();
    const profiles = new Map<string, AgentProfile>();

    for (const session of sessions) {
      if (!profiles.has(session.agentName)) {
        profiles.set(session.agentName, {
          name: session.agentName,
          sessions: 0,
          filesTouched: 0,
          patterns: [],
          fingerprint: { ...UNMEASURED_FINGERPRINT },
        });
      }
      const profile = profiles.get(session.agentName)!;
      profile.sessions++;
    }

    const agentFiles = getStatement(
      'SELECT agent_touched_by, COUNT(*) as cnt FROM files WHERE agent_touched_by IS NOT NULL GROUP BY agent_touched_by'
    ).all() as { agent_touched_by: string; cnt: number }[];

    for (const row of agentFiles) {
      const profile = profiles.get(row.agent_touched_by);
      if (profile) {
        profile.filesTouched = row.cnt;
      }
    }

    // Real fingerprints are computed from the actual content of agent-touched
    // files (capped). Agents without readable touched files keep -1/'unknown'.
    const touchedRows = getStatement(
      'SELECT agent_touched_by, relative_path FROM files WHERE agent_touched_by IS NOT NULL LIMIT 500'
    ).all() as { agent_touched_by: string; relative_path: string }[];

    const pathsByAgent = new Map<string, string[]>();
    for (const row of touchedRows) {
      const list = pathsByAgent.get(row.agent_touched_by) ?? [];
      list.push(row.relative_path);
      pathsByAgent.set(row.agent_touched_by, list);
    }

    for (const [agentName, paths] of pathsByAgent) {
      const profile = profiles.get(agentName);
      if (profile) {
        profile.fingerprint = computeFingerprint(paths);
      }
    }

    return [...profiles.values()];
  }

  getCoverageHeatmap(): { path: string; covered: boolean; load: number }[] {
    return this.kg.getAllFiles().map((f) => ({
      path: f.relativePath,
      covered: f.agentTouched,
      load: f.cognitiveLoad,
    }));
  }

  getUncoveredModules(): ModuleInfo[] {
    const report = this.getScaleReport();
    return report.modules.filter((m) => m.agentCoverage === 0);
  }

  getHighLoadModules(threshold: number = 0.5): ModuleInfo[] {
    const report = this.getScaleReport();
    return report.modules
      .filter((m) => m.cognitiveLoad > threshold)
      .sort((a, b) => b.cognitiveLoad - a.cognitiveLoad);
  }
}

/** -1 = unmeasured (no readable touched files); never fabricated. */
const UNMEASURED_FINGERPRINT: AgentProfile['fingerprint'] = {
  asyncPreference: -1,
  typeAssertionUsage: -1,
  errorHandlingStyle: 'unknown',
  namingConvention: 'unknown',
};

const FINGERPRINT_MAX_FILES = 30;
const FINGERPRINT_MAX_BYTES = 512 * 1024;

/**
 * Derive a coding-style fingerprint from the real content of files an agent
 * touched. All metrics are computed from source text; when nothing is
 * readable the unmeasured sentinel (-1/'unknown') is returned instead of a
 * placeholder value.
 */
function computeFingerprint(relativePaths: string[]): AgentProfile['fingerprint'] {
  const root = loadConfig().projectRoot;
  let asyncHits = 0;
  let thenHits = 0;
  let assertionCount = 0;
  let totalLines = 0;
  let tryBlocks = 0;
  let dotCatch = 0;
  let throws = 0;
  let resultObjects = 0;
  let camel = 0;
  let snake = 0;
  let pascal = 0;

  let read = 0;
  for (const rel of relativePaths) {
    if (read >= FINGERPRINT_MAX_FILES) break;
    let content: string;
    try {
      const buf = readFileSync(join(root, rel));
      if (buf.length > FINGERPRINT_MAX_BYTES) continue;
      content = buf.toString('utf-8');
    } catch {
      continue; // Deleted/moved/binary — skip silently.
    }
    read++;
    totalLines += content.split('\n').length;

    asyncHits += countMatches(content, /\b(?:async|await)\b/g);
    thenHits += countMatches(content, /\.then\s*\(/g);
    assertionCount += countMatches(content, /\bas\s+[A-Za-z_$][\w$.<>\[\]]*/g);
    tryBlocks += countMatches(content, /\btry\s*\{/g);
    dotCatch += countMatches(content, /\.catch\s*\(/g);
    throws += countMatches(content, /\bthrow\b/g);
    resultObjects += countMatches(content, /\{\s*(?:ok|err)\s*[:,]/g);

    for (const m of content.matchAll(/(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) {
      const name = m[1];
      if (/^[a-z][\w$]*$/.test(name)) camel++;
      else if (/^[a-z]+(?:_[a-z0-9]+)+$/.test(name)) snake++;
      else if (/^[A-Z][\w$]*$/.test(name)) pascal++;
    }
  }

  if (read === 0 || totalLines === 0) {
    return { ...UNMEASURED_FINGERPRINT };
  }

  // Promise-style (async/await) vs then-chain preference.
  const styleDenominator = asyncHits + thenHits;

  return {
    asyncPreference:
      styleDenominator > 0 ? round2(asyncHits / styleDenominator) : -1,
    // `as` assertions per 10 lines of code, capped at 1.0.
    typeAssertionUsage: Math.min(1, round2(assertionCount / (totalLines / 10))),
    errorHandlingStyle: classifyErrorHandling(tryBlocks, dotCatch, throws, resultObjects),
    namingConvention: dominantNaming(camel, snake, pascal),
  };
}

function countMatches(content: string, regex: RegExp): number {
  return (content.match(regex) ?? []).length;
}

function classifyErrorHandling(tryBlocks: number, dotCatch: number, throws: number, resultObjects: number): string {
  const styles: Array<[string, number]> = [
    ['try-catch', tryBlocks],
    ['promise-catch', dotCatch],
    ['throwing', throws],
    ['result-object', resultObjects],
  ];
  const active = styles.filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  if (active.length === 0) return 'unknown';
  if (active.length === 1) return active[0][0];
  // Dominant only when at least twice as common as the runner-up.
  return active[0][1] >= active[1][1] * 2 ? active[0][0] : 'mixed';
}

function dominantNaming(camel: number, snake: number, pascal: number): string {
  const total = camel + snake + pascal;
  if (total === 0) return 'unknown';
  const entries: Array<[string, number]> = [
    ['camelCase', camel],
    ['snake_case', snake],
    ['PascalCase', pascal],
  ];
  entries.sort((a, b) => b[1] - a[1]);
  return entries[0][1] >= total * 0.6 ? entries[0][0] : 'mixed';
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
