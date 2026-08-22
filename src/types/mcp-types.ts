/**
 * Shared types for MCP tool inputs and outputs.
 */

export interface FunctionInfo {
  id: number;
  name: string;
  signature: string | null;
  returnType: string | null;
  startLine: number | null;
  endLine: number | null;
  complexity: number | null;
}

export interface ClassInfo {
  id: number;
  name: string;
  signature: string | null;
  startLine: number | null;
  endLine: number | null;
  methodsCount: number | null;
  propertiesCount: number | null;
}

export interface ImportInfo {
  id: number;
  source: string;
  kind: string | null;
  resolved: boolean;
  resolvedPath: string | null;
  resolvedFile: {
    id: number;
    path: string;
    relativePath: string;
  } | null;
}

export interface DebtItemDTO {
  id: number;
  type: string;
  description: string;
  severity: string;
  suggestion: string;
  reasoningTrace: string[];
  detectedAt: string;
  resolved: boolean;
  filePath: string | null;
}

export interface ScaleReportDTO {
  totalFiles: number;
  totalBytes: number;
  totalLines: number;
  languages: Record<string, { files: number; bytes: number }>;
  modules: Array<{
    path: string;
    name: string;
    fileCount: number;
    totalBytes: number;
    cognitiveLoad: number;
    agentCoverage: number;
  }>;
  agentCoverage: number;
  avgCognitiveLoad: number;
  topHotspots: Array<{
    id: number;
    path: string;
    relativePath: string;
    cognitiveLoad: number;
  }>;
}

export interface GenomeScoreDTO {
  checksum: string | null;
  score: number;
  computedAt: string | null;
}

export interface AgentProfileDTO {
  name: string;
  sessions: number;
  filesTouched: number;
  patterns: string[];
}

export interface ScanProfileDTO {
  totalFiles: number;
  scannedFiles: number;
  errorFiles: number;
  durationMs: number;
  filesPerSecond: number;
  memoryUsedMB: number;
  errors: string[];
  createdAt?: string;
}
