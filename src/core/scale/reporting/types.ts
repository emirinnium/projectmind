import type { FileInfo } from '../../../storage/knowledge-graph.js';

export interface ModuleInfo {
  path: string;
  name: string;
  fileCount: number;
  totalBytes: number;
  cognitiveLoad: number;
  agentCoverage: number;
  files: FileInfo[];
}

export interface ScaleReport {
  totalFiles: number;
  totalBytes: number;
  totalLines: number;
  languages: Record<string, { files: number; bytes: number }>;
  modules: ModuleInfo[];
  agentCoverage: number;
  avgCognitiveLoad: number;
  topHotspots: FileInfo[];
  uncoveredFiles: FileInfo[];
  fingerprints: { asyncPreference: number; typeStrictness: number; errorHandlingStyle: string; namingConvention: string; testPattern: string; favoriteAbstractions: string[]; }[];
  scanDurationMs?: number;
  scanErrors?: string[];
}

export interface AgentProfile {
  name: string;
  sessions: number;
  filesTouched: number;
  patterns: string[];
  fingerprint: {
    asyncPreference: number;
    typeStrictness: number;
    errorHandlingStyle: string;
    namingConvention: string;
    testPattern: string;
    favoriteAbstractions: string[];
  };
}

export interface ScanProfile {
  totalFiles: number;
  scannedFiles: number;
  errorFiles: number;
  durationMs: number;
  filesPerSecond: number;
  memoryUsedMB: number;
  errors: string[];
  createdAt?: string;
}
