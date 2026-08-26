import { DatabaseSync } from 'node:sqlite';
import { getDatabase } from '../database.js';
import { SCHEMA_SQL } from '../schema.js';
import { FileStructure } from '../../parser/ast-parser.js';
import type { FileInfo, MemoryEntry, AgentSession } from './types.js';
import type { KgContext } from './helpers/context.js';
import { createGraphTraversal } from './graph-traversal.js';

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

export class KnowledgeGraph {
  readonly db: DatabaseSync;
  protected currentProjectId: number = 1;
  /** Cached in-memory traversal engine (invalidated via getGraphTraversal(true)). */
  private _traversal: ReturnType<typeof createGraphTraversal> | null = null;

  private get ctx(): KgContext {
    return { db: this.db, currentProjectId: this.currentProjectId };
  }

  constructor(db?: DatabaseSync) {
    this.db = db ?? getDatabase();
    this.db.exec(SCHEMA_SQL);
    this.ensureDefaultProject();
    this.loadCurrentProjectId();
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
    return upsertFile(this.ctx, fileStruct, relativePath);
  }

  storeFileDetails(fileId: number, fileStruct: FileStructure): void {
    storeFileDetails(this.ctx, fileId, fileStruct);
  }

  markAgentTouched(filePath: string, agentName: string): void {
    markAgentTouched(this.ctx, filePath, agentName);
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

  storeTeamMemory(params: { agentName: string; scope: string; key: string; value: string; isPublic: boolean }): void {
    storeTeamMemory(this.ctx, params);
  }

  getTeamMemories(params: { scope: string; agentName: string }): { id: number; agentName: string; scope: string; key: string; value: string; isPublic: boolean; createdAt: string; updatedAt: string }[] {
    return getTeamMemories(this.ctx, params);
  }

  /** Cross-scope team memories visible to the viewer (public + own). */
  getAllTeamMemories(viewerAgentName: string): { id: number; agentName: string; scope: string; key: string; value: string; isPublic: boolean; createdAt: string; updatedAt: string }[] {
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
}
