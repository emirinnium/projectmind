import type { DatabaseSync } from 'node:sqlite';

export interface KgContext {
  db: DatabaseSync;
  currentProjectId: number;
}
