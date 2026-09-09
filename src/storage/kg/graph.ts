import { relative } from 'node:path';
import { getVecIndex } from '../../core/embeddings/vector-index.js';
import { stableHash } from '../../utils/hash.js';
import { KnowledgeGraphIntelligence } from './knowledge-graph-intelligence.js';
import { invalidateCircularDependencyCache } from './helpers/imports.js';

export type { KnowledgeGraphDeps } from './knowledge-graph-base.js';

/** Shape of JSON stored in agent action memory entries. */
interface AgentAction {
  action: 'edit' | 'create' | 'delete';
  filePath: string;
  details: string;
}

/**
 * Public ProjectMind knowledge graph façade.
 *
 * The implementation is layered so the stable API stays discoverable while
 * storage, intelligence, and synchronization concerns remain independently
 * reviewable. All methods from the historical façade are inherited unchanged.
 */
export class KnowledgeGraph extends KnowledgeGraphIntelligence {
  /** Replay persisted agent actions and synchronize the graph with disk. */
  async replayAgentActions(
    agentName: string,
    sessionId?: number,
  ): Promise<{
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

    const project = this.getCurrentProject();
    if (!project) return { success: false, actions, errors: ['No active project'] };

    const memories = this.getMemory(
      'agent_actions',
      sessionId ? `session_${sessionId}` : agentName,
    );

    for (const memory of memories) {
      try {
        const parsed =
          typeof memory.value === 'string'
            ? (JSON.parse(memory.value) as AgentAction)
            : (memory.value as AgentAction);
        const { action, filePath, details } = parsed;

        if (action !== 'edit' && action !== 'create' && action !== 'delete') {
          errors.push(`Unknown action: ${action}`);
          continue;
        }
        if (typeof filePath !== 'string' || filePath.length === 0) {
          errors.push('Invalid agent action file path');
          continue;
        }

        const safePath = await this.resolveProjectPath(filePath, project.rootPath);
        if (!safePath) {
          errors.push(`File ${filePath} is not part of the current project`);
          continue;
        }

        switch (action) {
          case 'edit':
          case 'create': {
            const content = await this.deps.fs.readFile(safePath, 'utf-8');
            const fileStruct = this.deps.parser.parseFile(content, safePath);
            if (!fileStruct) {
              errors.push(`Failed to parse ${filePath}`);
              break;
            }
            const relativePath = relative(project.rootPath, safePath).replace(/\\/g, '/');
            const fileId = await this.upsertFile(fileStruct, relativePath);
            await this.storeFileDetails(fileId, fileStruct);
            await this.markAgentTouched(safePath, agentName);
            actions.push({ action, filePath: safePath, details, timestamp: memory.createdAt });
            break;
          }
          case 'delete': {
            const fileInfo = this.getFileByPath(safePath);
            if (fileInfo) {
              const storedPath = await this.resolveProjectPath(fileInfo.path, project.rootPath);
              if (!storedPath) {
                errors.push(`Stored file ${fileInfo.path} is not part of the current project`);
                break;
              }
              getVecIndex(this.db).remove(fileInfo.id);
              this.db.prepare('DELETE FROM files WHERE id = ?').run(fileInfo.id);
              this._traversal = null;
              // The import graph changed; do not serve a cached cycle result.
              invalidateCircularDependencyCache();
            }
            actions.push({ action, filePath: safePath, details, timestamp: memory.createdAt });
            break;
          }
        }
      } catch (error) {
        errors.push(
          `Error replaying action: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return { success: errors.length === 0, actions, errors };
  }

  /** Sync only changed or watched files into the knowledge graph. */
  async syncIncremental(filePaths: string[]): Promise<{ syncedFiles: number; errors: string[] }> {
    const errors: string[] = [];
    let syncedFiles = 0;
    const project = this.getCurrentProject();
    if (!project) return { syncedFiles: 0, errors: ['No active project'] };

    const now = new Date().toISOString();
    const watchedFilePaths = new Set(this.getAgentTouchedFiles().map((file) => file.path));

    for (const filePath of filePaths) {
      try {
        const safePath = await this.resolveProjectPath(filePath, project.rootPath);
        if (!safePath) {
          errors.push(`File ${filePath} is not part of the current project`);
          continue;
        }

        const fileInfo = this.getFileByPath(safePath);
        if (!fileInfo) {
          errors.push(`File not found: ${filePath}`);
          continue;
        }

        const isWatched = watchedFilePaths.has(filePath) || watchedFilePaths.has(safePath);
        const fileContent = (await this.deps.fs.readFile(safePath, 'utf-8')).replace(/^\uFEFF/, '');
        const contentChanged = stableHash(fileContent) !== fileInfo.hash;
        if (contentChanged || isWatched) {
          const fileStruct = this.deps.parser.parseFile(fileContent, safePath);
          if (!fileStruct) {
            errors.push(`Failed to parse ${filePath}`);
            continue;
          }
          const relativePath = relative(project.rootPath, safePath).replace(/\\/g, '/');
          await this.upsertFile(fileStruct, relativePath);
          await this.storeFileDetails(fileInfo.id, fileStruct);
          this.db.prepare('UPDATE files SET last_synced = ? WHERE id = ?').run(now, fileInfo.id);
          syncedFiles++;
        }
      } catch (error) {
        errors.push(
          `Error syncing file ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return { syncedFiles, errors };
  }
}
