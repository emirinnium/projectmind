import { DatabaseSync } from 'node:sqlite';

/**
 * Database migration type definition.
 */
export interface Migration {
  version: number;
  name: string;
  up: (db: DatabaseSync) => void;
  down?: (db: DatabaseSync) => void;
}
