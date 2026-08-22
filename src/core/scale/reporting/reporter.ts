import { dirname } from 'node:path';
import { getStatement } from '../../../storage/database.js';
import { KnowledgeGraph, FileInfo } from '../../../storage/knowledge-graph.js';
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
    ).get() as Record<string, unknown> | undefined;
    
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
          fingerprint: {
            asyncPreference: 0.5,
            typeAssertionUsage: 0.5,
            errorHandlingStyle: 'unknown',
            namingConvention: 'unknown',
          },
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
