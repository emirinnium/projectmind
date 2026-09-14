import { reportSuppressedError } from '../../../utils/errors.js';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import type { SQLOutputValue } from 'node:sqlite';
import { KnowledgeGraph, FileInfo } from '../../../storage/knowledge-graph.js';
import { loadConfig } from '../../../utils/config.js';
import { computeFingerprint } from './utils.js';
import type { ModuleInfo, ScaleReport, AgentProfile, ScanProfile } from './types.js';

/**
 * Handles scale reporting and metrics computation
 */
export class ScaleReporter {
  private kg: KnowledgeGraph;

  constructor(kg: KnowledgeGraph) {
    this.kg = kg;
  }

  private getProjectRoot(): string {
    // Request-local MCP scopes carry their own graph project/root. The config
    // fallback keeps lightweight integrations and historical test doubles
    // compatible without allowing a real scoped graph to leak to global root.
    return this.kg.getCurrentProject()?.rootPath ?? loadConfig().projectRoot;
  }

  getScaleReport(): ScaleReport {
    const allFiles = this.kg.getAllFiles();
    const projectRoot = this.getProjectRoot();

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

      try {
        const content = readFileSync(join(projectRoot, file.relativePath), 'utf8');
        totalLines += content.length === 0 ? 0 : content.split(/\r\n|\r|\n/).length;
      } catch (error) {
        reportSuppressedError(
          error,
          'Intentional fallback src/core/scale/reporting/reporter.ts:62',
        );
        // A deleted/unreadable file contributes no fabricated line estimate.
      }
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

    const fingerprints = allFiles
      .filter((f) => f.agentTouched)
      .map((f) => computeFingerprint([f.relativePath], projectRoot));

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
      fingerprints,
    };
  }

  storeScanProfile(profile: ScanProfile): void {
    this.kg.db
      .prepare(
        `INSERT INTO scan_profiles (project_id, total_files, scanned_files, error_files, skipped_files, skipped_paths, duration_ms, files_per_second, memory_used_mb, errors)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.kg.getCurrentProjectId(),
        profile.totalFiles,
        profile.scannedFiles,
        profile.errorFiles,
        profile.skippedFiles,
        profile.skippedPaths.length > 0 ? JSON.stringify(profile.skippedPaths) : null,
        profile.durationMs,
        profile.filesPerSecond,
        profile.memoryUsedMB,
        profile.errors.length > 0 ? JSON.stringify(profile.errors) : null,
      );
  }

  getLastScanProfile(): ScanProfile | null {
    const row = this.kg.db
      .prepare('SELECT * FROM scan_profiles WHERE project_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(this.kg.getCurrentProjectId()) as Record<string, SQLOutputValue> | undefined;

    if (!row) return null;

    return {
      totalFiles: row.total_files as number,
      scannedFiles: row.scanned_files as number,
      errorFiles: row.error_files as number,
      skippedFiles: (row.skipped_files as number | null) ?? 0,
      skippedPaths: row.skipped_paths ? JSON.parse(row.skipped_paths as string) : [],
      durationMs: row.duration_ms as number,
      filesPerSecond: row.files_per_second as number,
      memoryUsedMB: row.memory_used_mb as number,
      errors: row.errors ? JSON.parse(row.errors as string) : [],
      createdAt: row.created_at as string,
    };
  }

  getModuleInfo(modulePath: string): ModuleInfo | null {
    const files = this.kg.getAllFiles();
    const normalizedModule = modulePath.replace(/\\/g, '/').replace(/\/$/, '');
    const moduleFiles = files.filter((f) => {
      const relativePath = f.relativePath.replace(/\\/g, '/');
      return relativePath === normalizedModule || relativePath.startsWith(`${normalizedModule}/`);
    });
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

    const projectId = this.kg.getCurrentProjectId();
    const agentFiles = this.kg.db
      .prepare(
        'SELECT agent_touched_by, COUNT(*) as cnt FROM files WHERE project_id = ? AND agent_touched_by IS NOT NULL GROUP BY agent_touched_by',
      )
      .all(projectId) as { agent_touched_by: string; cnt: number }[];

    for (const row of agentFiles) {
      const profile = profiles.get(row.agent_touched_by);
      if (profile) {
        profile.filesTouched = row.cnt;
      }
    }

    // Real fingerprints are computed from the actual content of agent-touched
    // files (capped). Agents without readable touched files keep -1/'unknown'.
    const touchedRows = this.kg.db
      .prepare(
        'SELECT agent_touched_by, relative_path FROM files WHERE project_id = ? AND agent_touched_by IS NOT NULL LIMIT 500',
      )
      .all(projectId) as { agent_touched_by: string; relative_path: string }[];

    const pathsByAgent = new Map<string, string[]>();
    for (const row of touchedRows) {
      const list = pathsByAgent.get(row.agent_touched_by) ?? [];
      list.push(row.relative_path);
      pathsByAgent.set(row.agent_touched_by, list);
    }

    for (const [agentName, paths] of pathsByAgent) {
      const profile = profiles.get(agentName);
      if (profile) {
        profile.fingerprint = computeFingerprint(paths, this.getProjectRoot());
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
  typeStrictness: -1,
  errorHandlingStyle: 'unknown',
  namingConvention: 'unknown',
  testPattern: 'none',
  favoriteAbstractions: ['none'],
};
