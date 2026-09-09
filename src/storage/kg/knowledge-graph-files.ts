import type { FileInfo } from './types.js';
import type { FileStructure } from '../../parser/ast-parser.js';
import { getVecIndex } from '../../core/embeddings/vector-index.js';
import { KnowledgeGraphBase } from './knowledge-graph-base.js';
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
import { invalidateCircularDependencyCache } from './helpers/imports.js';

/** File, embedding, and data-flow methods for the public graph façade. */
export class KnowledgeGraphFiles extends KnowledgeGraphBase {
  getOrCreateResource(
    qualifiedName: string,
    kind: string,
    identity: string,
  ): { id: number; qualifiedName: string; kind: string; identity: string } {
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
  }): {
    id: number;
    fromResource: { id: number; qualifiedName: string; kind: string; identity: string };
    toResource: { id: number; qualifiedName: string; kind: string; identity: string };
  } {
    return recordDataFlow(this.ctx, params);
  }

  getDataFlows(projectId?: number): {
    id: number;
    fromResource: { id: number; qualifiedName: string; kind: string; identity: string };
    toResource: { id: number; qualifiedName: string; kind: string; identity: string };
    kind: string;
    via: string | null;
    sourceFunctionName: string | null;
    targetFunctionName: string | null;
  }[] {
    return getDataFlows(this.ctx, projectId);
  }

  getResourceFlows(resourceQualifiedName: string): {
    id: number;
    direction: string;
    resource: { id: number; qualifiedName: string; kind: string; identity: string };
    kind: string;
    via: string | null;
  }[] {
    return getResourceFlows(this.ctx, resourceQualifiedName);
  }

  clearDataFlows(projectId?: number): number {
    return clearDataFlows(this.ctx, projectId);
  }

  async upsertFile(fileStruct: FileStructure, relativePath: string): Promise<number> {
    const fileId = await upsertFile(this.ctx, fileStruct, relativePath);
    this._traversal = null;
    return fileId;
  }

  async storeFileDetails(fileId: number, fileStruct: FileStructure): Promise<void> {
    await storeFileDetails(this.ctx, fileId, fileStruct);
    invalidateCircularDependencyCache();
  }

  /** Remove a deleted source file and all cascaded graph/index data. */
  removeFile(path: string): boolean {
    const file = getFileByPath(this.ctx, path);
    if (!file) return false;

    getVecIndex(this.db).remove(file.id);
    this.db
      .prepare('DELETE FROM files WHERE id = ? AND project_id = ?')
      .run(file.id, this.currentProjectId);
    this._traversal = null;
    invalidateCircularDependencyCache();
    return true;
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

  getFunctions(fileId: number): {
    id: number;
    name: string;
    signature: string;
    complexity: number;
    startLine: number;
    endLine: number;
  }[] {
    return getFunctions(this.ctx, fileId);
  }

  getClasses(
    fileId: number,
  ): { id: number; name: string; methodsCount: number; propertiesCount: number }[] {
    return getClasses(this.ctx, fileId);
  }

  getImports(fileId: number): { source: string; named: string[]; kind: string }[] {
    return getImports(this.ctx, fileId);
  }

  getFileEmbedding(fileId: number): number[] | null {
    return getFileEmbedding(this.ctx, fileId);
  }

  resolveImportSource(source: string, fromDir?: string): FileInfo | null {
    return resolveImportSource(this.ctx, source, fromDir);
  }
}
