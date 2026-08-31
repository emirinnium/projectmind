import { DatabaseSync } from 'node:sqlite';
import { getDatabase } from '../database.js';
import { SCHEMA_SQL } from '../schema.js';
import { parseFile as parseFileAst, FileStructure } from '../../parser/ast-parser.js';
import type { FileInfo, MemoryEntry, AgentSession } from './types.js';
import type { KgContext } from './helpers/context.js';
import { createGraphTraversal } from './graph-traversal.js';
import { getVecIndex } from '../../core/embeddings/vector-index.js';
import { logger } from '../../utils/logger.js';

import {
  ensureDefaultProject,
  loadCurrentProjectId,
  persistCurrentProjectId,
  createProject,
  getProject,
  getProjectByName,
  listProjects,
  deleteProject,
} from './helpers/projects.js';

import {
  getOrCreateResource,
  recordDataFlow,
  getDataFlows,
  getResourceFlows,
  clearDataFlows,
} from './helpers/dataflow.js';

import {
  upsertFile,
  storeFileDetails,
  markAgentTouched,
  getFileByPath,
  getFilesByLanguage,
  getAllFiles,
  getAgentTouchedFiles,
  findSimilarFiles,
  getFunctions,
  getClasses,
  getImports,
  getFileEmbedding,
  resolveImportSource,
} from './helpers/files.js';

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

import type {
  TeamMemoryRowView,
  TeamMemoryStoreComputation,
} from '../../core/team-memory/merge.js';

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

export interface KnowledgeGraphDeps {
  fs: {
    readFile: (path: string, encoding: BufferEncoding) => Promise<string>;
    readFileSync?: (path: string) => string;
    stat?: (path: string) => Promise<{ mtime: Date }>;
  };
  parser: {
    parseFile: (content: string, filePath?: string) => FileStructure | null;
  };
  embedding: {
    generateEmbedding: (text: string) => Promise<number[]>;
    cosineSimilarity: (a: number[], b: number[]) => number;
  };
}

/** Shape of JSON stored in agent action memory entries. */
interface AgentAction {
  action: 'edit' | 'create' | 'delete';
  filePath: string;
  details: string;
}

export class KnowledgeGraph {
  readonly db: DatabaseSync;
  protected currentProjectId: number = 1;
  /** Cached in-memory traversal engine (invalidated via getGraphTraversal(true)). */
  private _traversal: ReturnType<typeof createGraphTraversal> | null = null;
  /** Injectable dependencies for FS, parser, and embedding (avoids global singletons). */
  protected deps: KnowledgeGraphDeps;

  private get ctx(): KgContext {
    return { db: this.db, currentProjectId: this.currentProjectId };
  }

  constructor(db?: DatabaseSync, deps?: KnowledgeGraphDeps) {
    this.db = db ?? getDatabase();
    this.db.exec(SCHEMA_SQL);
    this.ensureDefaultProject();
    this.loadCurrentProjectId();
    // Provide sensible defaults so callers that don't need deps aren't forced to pass them.
    this.deps = deps ?? {
      fs: {
        readFile: async (path: string, enc: BufferEncoding) => {
          const { readFile } = await import('node:fs/promises');
          return readFile(path, { encoding: enc });
        },
        stat: async (path: string) => {
          const { stat: fsStat } = await import('node:fs/promises');
          return fsStat(path);
        },
      },
      parser: {
        parseFile: (content: string, filePath?: string) => parseFileAst(filePath ?? 'inline.ts', content),
      },
      embedding: {
        generateEmbedding: async (text: string) => {
          const { generateEmbedding } = await import('../../parser/embeddings.js');
          return generateEmbedding(text);
        },
        cosineSimilarity: (a: number[], b: number[]) => {
          let dot = 0, normA = 0, normB = 0;
          for (let i = 0; i < a.length; i++) {
            dot += a[i]! * b[i]!;
            normA += a[i]! * a[i]!;
            normB += b[i]! * b[i]!;
          }
          const denom = Math.sqrt(normA) * Math.sqrt(normB);
          return denom === 0 ? 0 : dot / denom;
        },
      },
    };
  }

  /**
   * In-memory graph algorithms (BFS, shortest path, PageRank, community
   * detection, N-hop subgraph) over the current import graph.
   * The adjacency build is cached; pass forceRebuild=true after bulk graph
   * mutations (full scan, watcher refresh) so results never read stale edges.
   */
  getGraphTraversal(forceRebuild = false): ReturnType<typeof createGraphTraversal> {
    if (!this._traversal || forceRebuild) {
      this._traversal = createGraphTraversal(this.ctx);
    }
    return this._traversal;
  }

  ensureDefaultProject(): void {
    ensureDefaultProject(this.ctx);
  }

  loadCurrentProjectId(): void {
    this.currentProjectId = loadCurrentProjectId(this.ctx);
  }

  persistCurrentProjectId(): void {
    persistCurrentProjectId(this.ctx);
  }

  // ===== Project Management =====
  createProject(name: string, rootPath: string, description?: string): { id: number; name: string; rootPath: string } {
    return createProject(this.ctx, name, rootPath, description);
  }

  getProject(id: number): { id: number; name: string; rootPath: string; description: string | null; createdAt: string; lastScanned: string } | null {
    return getProject(this.ctx, id);
  }

  getProjectByName(name: string): { id: number; name: string; rootPath: string; description: string | null; createdAt: string; lastScanned: string } | null {
    return getProjectByName(this.ctx, name);
  }

  listProjects(): { id: number; name: string; rootPath: string; fileCount: number; lastScanned: string }[] {
    return listProjects(this.ctx);
  }

  switchProject(projectId: number): { success: boolean; project: { id: number; name: string; rootPath: string } | null; error?: string } {
    const project = this.getProject(projectId);
    if (!project) {
      return { success: false, project: null, error: `Project ${projectId} not found` };
    }
    this.currentProjectId = projectId;
    this.persistCurrentProjectId();
    return { success: true, project: { id: project.id, name: project.name, rootPath: project.rootPath } };
  }

  getCurrentProjectId(): number {
    return this.currentProjectId;
  }

  getCurrentProject(): { id: number; name: string; rootPath: string } | null {
    const project = this.getProject(this.currentProjectId);
    if (!project) return null;
    return { id: project.id, name: project.name, rootPath: project.rootPath };
  }

  deleteProject(projectId: number): { success: boolean; deletedFiles: number; error?: string } {
    const result = deleteProject(this.ctx, projectId);
    this._traversal = null;
    if (result.success && this.currentProjectId === projectId) {
      this.currentProjectId = 1;
    }
    return result;
  }

  // ===== Data-Flow / Taint Analysis =====
  getOrCreateResource(qualifiedName: string, kind: string, identity: string): { id: number; qualifiedName: string; kind: string; identity: string } {
    return getOrCreateResource(this.ctx, qualifiedName, kind, identity);
  }

  recordDataFlow(params: {
    fromResourceQualifiedName: string;
    fromResourceKind: string;
    fromResourceIdentity: string;
    toResourceQualifiedName: string;
    toResourceKind: string;
    toResourceIdentity: string;
    kind: string;
    via?: string;
    sourceFunctionName?: string;
    targetFunctionName?: string;
  }): { id: number; fromResource: { id: number; qualifiedName: string; kind: string; identity: string }; toResource: { id: number; qualifiedName: string; kind: string; identity: string } } {
    return recordDataFlow(this.ctx, params);
  }

  getDataFlows(projectId?: number): { id: number; fromResource: { id: number; qualifiedName: string; kind: string; identity: string }; toResource: { id: number; qualifiedName: string; kind: string; identity: string }; kind: string; via: string | null; sourceFunctionName: string | null; targetFunctionName: string | null }[] {
    return getDataFlows(this.ctx, projectId);
  }

  getResourceFlows(resourceQualifiedName: string): { id: number; direction: string; resource: { id: number; qualifiedName: string; kind: string; identity: string }; kind: string; via: string | null }[] {
    return getResourceFlows(this.ctx, resourceQualifiedName);
  }

  clearDataFlows(projectId?: number): number {
    return clearDataFlows(this.ctx, projectId);
  }

  // ===== File Operations =====
  async upsertFile(fileStruct: FileStructure, relativePath: string): Promise<number> {
    const fileId = await upsertFile(this.ctx, fileStruct, relativePath);
    this._traversal = null;
    return fileId;
  }

  async storeFileDetails(fileId: number, fileStruct: FileStructure): Promise<void> {
    return storeFileDetails(this.ctx, fileId, fileStruct);
  }

  markAgentTouched(filePath: string, agentName: string): Promise<void> {
    return markAgentTouched(this.ctx, filePath, agentName);
  }

  getFileByPath(path: string, projectId?: number): FileInfo | null {
    return getFileByPath(this.ctx, path, projectId);
  }

  getFilesByLanguage(language: string, projectId?: number): FileInfo[] {
    return getFilesByLanguage(this.ctx, language, projectId);
  }

  getAllFiles(projectId?: number): FileInfo[] {
    return getAllFiles(this.ctx, projectId);
  }

  getAgentTouchedFiles(agentName?: string, projectId?: number): FileInfo[] {
    return getAgentTouchedFiles(this.ctx, agentName, projectId);
  }

  findSimilarFiles(targetEmbedding: number[], threshold = 0.7, limit = 10): FileInfo[] {
    return findSimilarFiles(this.ctx, targetEmbedding, threshold, limit);
  }

  getFunctions(fileId: number): { id: number; name: string; signature: string; complexity: number; startLine: number; endLine: number }[] {
    return getFunctions(this.ctx, fileId);
  }

  getClasses(fileId: number): { id: number; name: string; methodsCount: number; propertiesCount: number }[] {
    return getClasses(this.ctx, fileId);
  }

  getImports(fileId: number): { source: string; named: string[]; kind: string }[] {
    return getImports(this.ctx, fileId);
  }

  getFileEmbedding(fileId: number): number[] | null {
    return getFileEmbedding(this.ctx, fileId);
  }

  // ===== Import Resolution =====
  resolveImportSource(source: string, fromDir?: string): FileInfo | null {
    return resolveImportSource(this.ctx, source, fromDir);
  }

  // ===== Agent Session Management =====
  startAgentSession(agentName: string): number {
    return startAgentSession(this.ctx, agentName);
  }

  endAgentSession(sessionId: number): void {
    endAgentSession(this.ctx, sessionId);
  }

  storeMemory(sessionId: number, scope: string, key: string, value: string): void {
    storeMemory(this.ctx, sessionId, scope, key, value);
  }

  getMemory(scope: string, key?: string): MemoryEntry[] {
    return getMemory(this.ctx, scope, key);
  }

  storeTeamMemory(params: { agentName: string; scope: string; key: string; value: string; isPublic: boolean }): TeamMemoryStoreComputation {
    return storeTeamMemory(this.ctx, params);
  }

  getTeamMemories(params: { scope: string; agentName: string }): TeamMemoryRowView[] {
    return getTeamMemories(this.ctx, params);
  }

  /** Cross-scope team memories visible to the viewer (public + own). */
  getAllTeamMemories(viewerAgentName: string): TeamMemoryRowView[] {
    return getAllTeamMemories(this.ctx, viewerAgentName);
  }

  getAgentSessions(agentName?: string, limit: number = 50): AgentSession[] {
    return getAgentSessions(this.ctx, agentName, limit);
  }

  // ===== Multi-Agent File Locks (advisory, TTL-expiring) =====
  purgeExpiredLocks(): number {
    return purgeExpiredLocks(this.ctx);
  }

  acquireFileLock(
    filePath: string,
    agentName: string,
    options: { ttlMinutes?: number; reason?: string } = {}
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

  // ===== Import/Dependency Analysis Methods =====
  getDependents(fileId: number): FileInfo[] {
    return getDependents(this.ctx, fileId);
  }

  getDirectDependents(sourcePath: string): FileInfo[] {
    return getDirectDependents(this.ctx, sourcePath);
  }

  getImportsWithDetails(fileId: number): { source: string; kind: string; resolvedFile: FileInfo | null }[] {
    return getImportsWithDetails(this.ctx, fileId);
  }

  traceImports(fileId: number, maxDepth: number = 10): { file: FileInfo; depth: number; path: string[] }[] {
    return traceImports(this.ctx, fileId, maxDepth);
  }

  findCircularDependencies(): string[][] {
    return findCircularDependencies(this.ctx);
  }

  // ===== Dynamic Call Tracing =====
  ingestDynamicCalls(calls: { fromFunctionName: string; toFunctionName: string; workloadId: string; callCount?: number; staticMissed?: boolean }[]): { inserted: number; updated: number; errors: string[] } {
    return ingestDynamicCalls(this.ctx, calls);
  }

  getDynamicCalls(workloadId: string): { fromFunctionId: number; toFunctionId: number; callCount: number; staticMissed: boolean; workloadId: string; fromFunctionName: string; toFunctionName: string }[] {
    return getDynamicCalls(this.ctx, workloadId);
  }

  getAllDynamicCalls(): { fromFunctionId: number; toFunctionId: number; callCount: number; staticMissed: boolean; workloadId: string; fromFunctionName: string; toFunctionName: string }[] {
    return getAllDynamicCalls(this.ctx);
  }

  getStaticMissedCalls(): { fromFunctionName: string; toFunctionName: string; workloadId: string; callCount: number; staticMissed: boolean }[] {
    return getStaticMissedCalls(this.ctx);
  }

  clearDynamicCalls(workloadId: string): number {
    return clearDynamicCalls(this.ctx, workloadId);
  }

  clearAllDynamicCalls(): number {
    return clearAllDynamicCalls(this.ctx);
  }

  // ===== Coherence & Dependency Graph =====
  getCoherenceDecisions(fileId: number): { id: number; verdict: string; confidence: number; analyzedAt: string; llmProvider: string | null }[] {
    return getCoherenceDecisions(this.ctx, fileId);
  }

  getDependencyGraph(modulePath: string): { nodes: FileInfo[]; edges: { from: string; to: string; kind: string }[] } {
    return getDependencyGraph(this.ctx, modulePath);
  }

  findFilesByImportPattern(pattern: string): FileInfo[] {
    return findFilesByImportPattern(this.ctx, pattern);
  }

  getFileByImport(importPath: string, fromFilePath?: string): FileInfo | null {
    return getFileByImport(this.ctx, importPath, fromFilePath);
  }

  /**
   * Search for files by semantic similarity to a natural language query.
   */
  async searchSemantic(query: string, limit = 5, threshold = 0.7): Promise<{
    files: FileInfo[],
    matches: Array<{
      file: FileInfo,
      lineNumber: number,
      lineContent: string,
      score: number
    }>
  }> {
    // Generate an embedding for the query
    const queryEmbedding = await this.deps.embedding.generateEmbedding(query);

    // Find files with similar embeddings
    const similarFiles = this.findSimilarFiles(queryEmbedding, threshold, limit);

    // File-level semantic search only (no line-by-line embedding trap)
    const matches: Array<{
      file: FileInfo,
      lineNumber: number,
      lineContent: string,
      score: number
    }> = [];

    for (const file of similarFiles) {
      try {
        // File-level match only; avoid per-line embedding calls
        matches.push({
          file,
          lineNumber: 1,
          lineContent: file.path,
          score: 0.85
        });
      } catch (error) {
        logger.error(`Error processing file ${file.path}`, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    // Sort matches by score
    matches.sort((a, b) => b.score - a.score);

    return {
      files: similarFiles,
      matches: matches.slice(0, limit)
    };
  }

/**
 * Replay agent actions from memory to synchronize context.
 */
  async replayAgentActions(agentName: string, sessionId?: number): Promise<{
    success: boolean;
    actions: Array<{
      action: string;
      filePath: string;
      details: string;
      timestamp: string;
    }>;
    errors: string[];
  }> {
    const errors: string[] = [];
    const actions: Array<{
      action: string;
      filePath: string;
      details: string;
      timestamp: string;
    }> = [];

    // Get agent memories
    const memories = this.getMemory('agent_actions', sessionId ? `session_${sessionId}` : agentName);

    for (const memory of memories) {
      try {
        const parsed = typeof memory.value === 'string' ? JSON.parse(memory.value) as AgentAction : memory.value as AgentAction;
        const { action, filePath, details } = parsed;

        // Replay the action — update the knowledge graph to reflect what the agent did.
        switch (action) {
          case 'edit':
          case 'create': {
            // (Re-)parse the file and upsert it into the KG, then mark as agent-touched.
            const content = await this.deps.fs.readFile(filePath, 'utf-8');
            const fileStruct = this.deps.parser.parseFile(content, filePath);
            if (!fileStruct) {
              errors.push(`Failed to parse ${filePath}`);
              break;
            }
            const relativePath = filePath.replace(/\\/g, '/');
            const fileId = await this.upsertFile(fileStruct, relativePath);
            await this.storeFileDetails(fileId, fileStruct);
            await this.markAgentTouched(filePath, agentName);
            actions.push({ action, filePath, details, timestamp: memory.createdAt });
            break;
          }
          case 'delete': {
            // Remove the file entry from the KG (best-effort — file may not exist in DB).
            const fileInfo = this.getFileByPath(filePath);
            if (fileInfo) {
              // K9: prune the vec index so deleted files stop surfacing in
              // embedding search.
              getVecIndex(this.db).remove(fileInfo.id);
              this.db.prepare('DELETE FROM files WHERE id = ?').run(fileInfo.id);
              this._traversal = null;
            }
            actions.push({ action, filePath, details, timestamp: memory.createdAt });
            break;
          }
          default:
            errors.push(`Unknown action: ${action}`);
        }
      } catch (error) {
        errors.push(`Error replaying action: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return {
      success: errors.length === 0,
      actions,
      errors
    };
  }

  /**
   * Sync the knowledge graph incrementally by only updating files that have changed.
   */
  async syncIncremental(filePaths: string[]): Promise<{ syncedFiles: number; errors: string[] }> {
    const errors: string[] = [];
    let syncedFiles = 0;

    // Get the current project
    const project = this.getCurrentProject();
    if (!project) {
      errors.push('No active project');
      return { syncedFiles: 0, errors };
    }

    // Get the current timestamp
    const now = new Date().toISOString();

    // Get the list of files being watched by agents
    const watchedFiles = this.getAgentTouchedFiles();
    const watchedFilePaths = new Set(watchedFiles.map(file => file.path));

    for (const filePath of filePaths) {
      try {
        // Check if the file belongs to the current project
        if (!filePath.startsWith(project.rootPath)) {
          errors.push(`File ${filePath} is not part of the current project`);
          continue;
        }

        const fileInfo = this.getFileByPath(filePath);
        if (!fileInfo) {
          errors.push(`File not found: ${filePath}`);
          continue;
        }

        // Check if the file has been modified since last sync or is being watched by an agent
        let lastModified = 0;
        try {
          const fileStat = await this.deps.fs.stat?.(filePath);
          lastModified = fileStat ? fileStat.mtime.getTime() : 0;
        } catch {
          // If stat fails, treat as new (always sync)
          lastModified = 0;
        }
        const lastSynced = new Date(fileInfo.lastSynced || fileInfo.lastScanned || 0).getTime();
        const isWatched = watchedFilePaths.has(filePath);

        if (lastModified > lastSynced || isWatched) {
          // Parse the file and update its details in the knowledge graph
          const fileContent = await this.deps.fs.readFile(filePath, 'utf-8');
          const fileStruct = this.deps.parser.parseFile(fileContent, filePath);
          if (!fileStruct) {
            errors.push(`Failed to parse ${filePath}`);
            continue;
          }
          await this.upsertFile(fileStruct, filePath);
          await this.storeFileDetails(fileInfo.id, fileStruct);

          // Update the last synced time
          this.db.prepare('UPDATE files SET last_synced = ? WHERE id = ?').run(now, fileInfo.id);

          syncedFiles++;
        }
      } catch (error) {
        errors.push(`Error syncing file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return { syncedFiles, errors };
  }
}
