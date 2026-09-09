import { DatabaseSync } from 'node:sqlite';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { getDatabase } from '../database.js';
import { SCHEMA_SQL } from '../schema.js';
import { parseFile as parseFileAst } from '../../parser/ast-parser.js';
import type { FileStructure } from '../../parser/ast-parser.js';
import type { KgContext } from './helpers/context.js';
import { createGraphTraversal } from './graph-traversal.js';
import { loadConfig } from '../../utils/config.js';

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

export interface KnowledgeGraphDeps {
  fs: {
    readFile: (path: string, encoding: BufferEncoding) => Promise<string>;
    readFileSync?: (path: string) => string;
    stat?: (path: string) => Promise<{ mtime: Date }>;
    /** Optional realpath seam used to reject symlink escapes from the project. */
    realpath?: (path: string) => Promise<string>;
  };
  parser: {
    parseFile: (content: string, filePath?: string) => FileStructure | null;
  };
  embedding: {
    generateEmbedding: (text: string) => Promise<number[]>;
    cosineSimilarity: (a: number[], b: number[]) => number;
  };
}

type PathConvention = 'windows' | 'posix' | 'relative';

function classifyPathConvention(filePath: string): PathConvention {
  if (/^[A-Za-z]:/.test(filePath) || /^[\\/]{2}/.test(filePath)) return 'windows';
  if (filePath.startsWith('/')) return 'posix';
  return 'relative';
}

function isPathInside(parent: string, candidate: string): boolean {
  const relativePath = relative(resolve(parent), resolve(candidate));
  return (
    relativePath === '' ||
    (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
}

/** Confine a persisted path to a project root across Windows and POSIX hosts. */
function confinePathToProject(filePath: string, projectRoot: string): string | null {
  if (!filePath || filePath.includes('\0')) return null;

  const rootConvention = classifyPathConvention(projectRoot);
  const inputConvention = classifyPathConvention(filePath);
  if (inputConvention === 'windows' && /^[A-Za-z]:[^\\/]/.test(filePath)) return null;
  if (inputConvention !== 'relative' && inputConvention !== rootConvention) return null;

  const absolutePath = resolve(projectRoot, filePath);
  return isPathInside(projectRoot, absolutePath) ? absolutePath : null;
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

/** Shared database, project, traversal, and path-safety behavior. */
export class KnowledgeGraphBase {
  readonly db: DatabaseSync;
  protected currentProjectId = 1;
  protected projectRoot: string;
  /** Cached in-memory traversal engine (invalidated by graph mutations). */
  protected _traversal: ReturnType<typeof createGraphTraversal> | null = null;
  /** Injectable dependencies for FS, parser, and embedding. */
  protected deps: KnowledgeGraphDeps;

  protected get ctx(): KgContext {
    return { db: this.db, currentProjectId: this.currentProjectId, projectRoot: this.projectRoot };
  }

  constructor(db?: DatabaseSync, deps?: KnowledgeGraphDeps) {
    const config = loadConfig();
    const embeddingDimension = config.embeddings.dimension;
    this.projectRoot = config.projectRoot;
    this.db = db ?? getDatabase();
    this.db.exec(SCHEMA_SQL);
    this.ensureDefaultProject();
    this.loadCurrentProjectId();
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
        realpath: async (path: string) => {
          const { realpath } = await import('node:fs/promises');
          return realpath(path);
        },
      },
      parser: {
        parseFile: (content: string, filePath?: string) =>
          parseFileAst(filePath ?? 'inline.ts', content),
      },
      embedding: {
        generateEmbedding: async (text: string) => {
          const { generateEmbedding } = await import('../../parser/embeddings.js');
          return generateEmbedding(text, embeddingDimension);
        },
        cosineSimilarity: (a: number[], b: number[]) => {
          let dot = 0;
          let normA = 0;
          let normB = 0;
          for (let i = 0; i < a.length; i++) {
            if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) return 0;
            dot += a[i]! * b[i]!;
            normA += a[i]! * a[i]!;
            normB += b[i]! * b[i]!;
          }
          const denominator = Math.sqrt(normA) * Math.sqrt(normB);
          if (denominator === 0 || !Number.isFinite(denominator)) return 0;
          const score = dot / denominator;
          return Number.isFinite(score) ? score : 0;
        },
      },
    };
  }

  /** Confine a graph path and verify its nearest existing ancestor's realpath. */
  protected async resolveProjectPath(
    filePath: string,
    projectRoot = this.projectRoot,
  ): Promise<string | null> {
    const absolutePath = confinePathToProject(filePath, projectRoot);
    if (!absolutePath || !this.deps.fs.realpath) return absolutePath;

    let canonicalRoot = resolve(projectRoot);
    try {
      canonicalRoot = await this.deps.fs.realpath(canonicalRoot);
    } catch (error) {
      if (!isMissingPathError(error)) return null;
    }

    let probePath = absolutePath;
    for (;;) {
      try {
        const canonicalPath = await this.deps.fs.realpath(probePath);
        return isPathInside(canonicalRoot, canonicalPath) ? absolutePath : null;
      } catch (error) {
        if (!isMissingPathError(error)) return null;
        const parentPath = dirname(probePath);
        if (parentPath === probePath) return absolutePath;
        probePath = parentPath;
      }
    }
  }

  getGraphTraversal(forceRebuild = false): ReturnType<typeof createGraphTraversal> {
    if (!this._traversal || forceRebuild) this._traversal = createGraphTraversal(this.ctx);
    return this._traversal;
  }

  ensureDefaultProject(): void {
    ensureDefaultProject(this.ctx);
  }

  loadCurrentProjectId(): void {
    this.currentProjectId = loadCurrentProjectId(this.ctx);
    const project = getProject(this.ctx, this.currentProjectId);
    if (project?.rootPath) this.projectRoot = project.rootPath;
  }

  persistCurrentProjectId(): void {
    persistCurrentProjectId(this.ctx);
  }

  createProject(
    name: string,
    rootPath: string,
    description?: string,
  ): { id: number; name: string; rootPath: string } {
    return createProject(this.ctx, name, rootPath, description);
  }

  getProject(id: number): {
    id: number;
    name: string;
    rootPath: string;
    description: string | null;
    createdAt: string;
    lastScanned: string;
  } | null {
    return getProject(this.ctx, id);
  }

  getProjectByName(name: string): {
    id: number;
    name: string;
    rootPath: string;
    description: string | null;
    createdAt: string;
    lastScanned: string;
  } | null {
    return getProjectByName(this.ctx, name);
  }

  listProjects(): {
    id: number;
    name: string;
    rootPath: string;
    fileCount: number;
    lastScanned: string;
  }[] {
    return listProjects(this.ctx);
  }

  switchProject(projectId: number): {
    success: boolean;
    project: { id: number; name: string; rootPath: string } | null;
    error?: string;
  } {
    const project = this.getProject(projectId);
    if (!project) return { success: false, project: null, error: `Project ${projectId} not found` };
    this.currentProjectId = projectId;
    this.projectRoot = project.rootPath;
    this.persistCurrentProjectId();
    return {
      success: true,
      project: { id: project.id, name: project.name, rootPath: project.rootPath },
    };
  }

  getCurrentProjectId(): number {
    return this.currentProjectId;
  }

  getCurrentProject(): { id: number; name: string; rootPath: string } | null {
    const project = this.getProject(this.currentProjectId);
    return project ? { id: project.id, name: project.name, rootPath: project.rootPath } : null;
  }

  deleteProject(projectId: number): { success: boolean; deletedFiles: number; error?: string } {
    const result = deleteProject(this.ctx, projectId);
    this._traversal = null;
    if (result.success && this.currentProjectId === projectId) {
      this.currentProjectId = 1;
      const defaultProject = this.getProject(1);
      if (defaultProject?.rootPath) this.projectRoot = defaultProject.rootPath;
    }
    return result;
  }
}
