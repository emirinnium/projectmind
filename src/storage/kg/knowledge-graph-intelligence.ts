import { logger } from '../../utils/logger.js';
import type { AgentSession, FileInfo, MemoryEntry } from './types.js';
import type {
  TeamMemoryRowView,
  TeamMemoryStoreComputation,
} from '../../core/team-memory/merge.js';
import { KnowledgeGraphFiles } from './knowledge-graph-files.js';
import {
  startAgentSession,
  endAgentSession,
  storeMemory,
  getMemory,
  storeTeamMemory,
  getTeamMemories,
  getAllTeamMemories,
  getAgentSessions,
} from './helpers/agents.js';
import {
  purgeExpiredLocks,
  acquireFileLock,
  releaseFileLock,
  getActiveLocks,
  checkFileConflicts,
  type FileLock,
  type AcquireResult,
  type ReleaseResult,
  type ConflictReport,
} from './helpers/locks.js';
import {
  getDependents,
  getDirectDependents,
  getImportsWithDetails,
  getImportStats,
  traceImports,
  findCircularDependencies,
  ingestDynamicCalls,
  getDynamicCalls,
  getAllDynamicCalls,
  getStaticMissedCalls,
  clearDynamicCalls,
  clearAllDynamicCalls,
  getCoherenceDecisions,
  getDependencyGraph,
  findFilesByImportPattern,
  getFileByImport,
} from './helpers/imports.js';

/** Agent, import, trace, and semantic-search behavior for the graph façade. */
export class KnowledgeGraphIntelligence extends KnowledgeGraphFiles {
  startAgentSession(agentName: string): number {
    return startAgentSession(this.ctx, agentName);
  }

  endAgentSession(sessionId: number): boolean {
    return endAgentSession(this.ctx, sessionId);
  }

  storeMemory(sessionId: number, scope: string, key: string, value: string): void {
    storeMemory(this.ctx, sessionId, scope, key, value);
  }

  getMemory(scope: string, key?: string): MemoryEntry[] {
    return getMemory(this.ctx, scope, key);
  }

  storeTeamMemory(params: {
    agentName: string;
    scope: string;
    key: string;
    value: string;
    isPublic: boolean;
  }): TeamMemoryStoreComputation {
    return storeTeamMemory(this.ctx, params);
  }

  getTeamMemories(params: { scope: string; agentName: string }): TeamMemoryRowView[] {
    return getTeamMemories(this.ctx, params);
  }

  getAllTeamMemories(viewerAgentName: string): TeamMemoryRowView[] {
    return getAllTeamMemories(this.ctx, viewerAgentName);
  }

  getAgentSessions(agentName?: string, limit = 50): AgentSession[] {
    return getAgentSessions(this.ctx, agentName, limit);
  }

  purgeExpiredLocks(): number {
    return purgeExpiredLocks(this.ctx);
  }

  acquireFileLock(
    filePath: string,
    agentName: string,
    options: { ttlMinutes?: number; reason?: string } = {},
  ): AcquireResult {
    return acquireFileLock(this.ctx, filePath, agentName, options);
  }

  releaseFileLock(filePath: string, agentName: string): ReleaseResult {
    return releaseFileLock(this.ctx, filePath, agentName);
  }

  getActiveLocks(agentName?: string): FileLock[] {
    return getActiveLocks(this.ctx, agentName);
  }

  checkFileConflicts(filePaths: string[], agentName: string): ConflictReport {
    return checkFileConflicts(this.ctx, filePaths, agentName);
  }

  getDependents(fileId: number): FileInfo[] {
    return getDependents(this.ctx, fileId);
  }

  getDirectDependents(sourcePath: string): FileInfo[] {
    return getDirectDependents(this.ctx, sourcePath);
  }

  getImportsWithDetails(
    fileId: number,
  ): { source: string; kind: string; resolvedFile: FileInfo | null }[] {
    return getImportsWithDetails(this.ctx, fileId);
  }

  getImportStats(): {
    totalImports: number;
    resolvedImports: number;
    unresolvedImports: number;
    externalDependencies: number;
  } {
    return getImportStats(this.ctx);
  }

  traceImports(fileId: number, maxDepth = 10): { file: FileInfo; depth: number; path: string[] }[] {
    return traceImports(this.ctx, fileId, maxDepth);
  }

  findCircularDependencies(): string[][] {
    return findCircularDependencies(this.ctx);
  }

  ingestDynamicCalls(
    calls: Array<{
      fromFunctionName: string;
      toFunctionName: string;
      workloadId: string;
      callCount?: number;
      staticMissed?: boolean;
    }>,
  ): { inserted: number; updated: number; errors: string[] } {
    return ingestDynamicCalls(this.ctx, calls);
  }

  getDynamicCalls(workloadId: string): Array<{
    fromFunctionId: number;
    toFunctionId: number;
    callCount: number;
    staticMissed: boolean;
    workloadId: string;
    fromFunctionName: string;
    toFunctionName: string;
  }> {
    return getDynamicCalls(this.ctx, workloadId);
  }

  getAllDynamicCalls(): Array<{
    fromFunctionId: number;
    toFunctionId: number;
    callCount: number;
    staticMissed: boolean;
    workloadId: string;
    fromFunctionName: string;
    toFunctionName: string;
  }> {
    return getAllDynamicCalls(this.ctx);
  }

  getStaticMissedCalls(): Array<{
    fromFunctionName: string;
    toFunctionName: string;
    workloadId: string;
    callCount: number;
    staticMissed: boolean;
  }> {
    return getStaticMissedCalls(this.ctx);
  }

  clearDynamicCalls(workloadId: string): number {
    return clearDynamicCalls(this.ctx, workloadId);
  }

  clearAllDynamicCalls(): number {
    return clearAllDynamicCalls(this.ctx);
  }

  getCoherenceDecisions(fileId: number): Array<{
    id: number;
    verdict: string;
    confidence: number;
    analyzedAt: string;
    llmProvider: string | null;
  }> {
    return getCoherenceDecisions(this.ctx, fileId);
  }

  getDependencyGraph(modulePath: string): {
    nodes: FileInfo[];
    edges: { from: string; to: string; kind: string }[];
  } {
    return getDependencyGraph(this.ctx, modulePath);
  }

  findFilesByImportPattern(pattern: string): FileInfo[] {
    return findFilesByImportPattern(this.ctx, pattern);
  }

  getFileByImport(importPath: string, fromFilePath?: string): FileInfo | null {
    return getFileByImport(this.ctx, importPath, fromFilePath);
  }

  /** Search indexed file embeddings while preserving the legacy result shape. */
  async searchSemantic(
    query: string,
    limit = 5,
    threshold = 0.7,
  ): Promise<{
    files: FileInfo[];
    matches: Array<{ file: FileInfo; lineNumber: number; lineContent: string; score: number }>;
  }> {
    const queryEmbedding = await this.deps.embedding.generateEmbedding(query);
    const similarFiles = this.findSimilarFiles(queryEmbedding, threshold, limit);
    const matches: Array<{
      file: FileInfo;
      lineNumber: number;
      lineContent: string;
      score: number;
    }> = [];

    for (const file of similarFiles) {
      try {
        const fileEmbedding = this.getFileEmbedding(file.id);
        const score = fileEmbedding
          ? this.deps.embedding.cosineSimilarity(queryEmbedding, fileEmbedding)
          : 0;
        matches.push({ file, lineNumber: 1, lineContent: file.path, score });
      } catch (error) {
        logger.error(`Error processing file ${file.path}`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    matches.sort((a, b) => b.score - a.score);
    return {
      files: similarFiles,
      matches: matches.slice(0, limit),
    };
  }
}
