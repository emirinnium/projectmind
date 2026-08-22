import { DatabaseSync } from 'node:sqlite';
import { getDatabase } from '../../storage/database.js';
import { SCHEMA_SQL } from '../../storage/schema.js';
import { KnowledgeGraph } from '../../storage/knowledge-graph.js';
import { ProjectScanner, ScaleReporter, ScanProfile } from './reporting/index.js';
import type { ModuleInfo, ScaleReport, AgentProfile } from './reporting/index.js';

export type { ModuleInfo, ScaleReport, AgentProfile, ScanProfile } from './reporting/index.js';

export class ScaleManager {
  private db: DatabaseSync;
  private kg: KnowledgeGraph;
  private scanner: ProjectScanner;
  private reporter: ScaleReporter;

  constructor(db?: DatabaseSync, kg?: KnowledgeGraph) {
    this.db = db ?? getDatabase();
    this.db.exec(SCHEMA_SQL);
    this.kg = kg ?? new KnowledgeGraph();
    this.scanner = new ProjectScanner(this.db, this.kg);
    this.reporter = new ScaleReporter(this.kg);
  }

  async scanProject(rootPath?: string, full?: boolean): Promise<{ scanned: number; errors: number; totalFiles: number }> {
    const profile = await this.scanner.scanProjectWithProfile(rootPath, full);
    return { scanned: profile.scannedFiles, errors: profile.errorFiles, totalFiles: profile.totalFiles };
  }

  async scanProjectWithProfile(rootPath?: string, full?: boolean): Promise<ScanProfile> {
    const profile = await this.scanner.scanProjectWithProfile(rootPath, full);
    this.reporter.storeScanProfile(profile);
    return profile;
  }

  getScaleReport(): ScaleReport {
    return this.reporter.getScaleReport();
  }

  getLastScanProfile(): ScanProfile | null {
    return this.reporter.getLastScanProfile();
  }

  getModuleInfo(modulePath: string): ModuleInfo | null {
    return this.reporter.getModuleInfo(modulePath);
  }

  getAgentProfiles(): AgentProfile[] {
    return this.reporter.getAgentProfiles();
  }

  getCoverageHeatmap(): { path: string; covered: boolean; load: number }[] {
    return this.reporter.getCoverageHeatmap();
  }

  getUncoveredModules(): ModuleInfo[] {
    return this.reporter.getUncoveredModules();
  }

  getHighLoadModules(threshold: number = 0.5): ModuleInfo[] {
    return this.reporter.getHighLoadModules(threshold);
  }
}