import type { DatabaseSync } from 'node:sqlite';

export interface KgContext {
  db: DatabaseSync;
  currentProjectId: number;
  /** Project root used to apply the project-local `.pmignore` boundary. */
  projectRoot?: string;
}
