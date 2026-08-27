declare module 'sqlite-vec' {
  import type { DatabaseSync } from 'node:sqlite';

  /** Return the absolute path to the platform-specific loadable extension (.dll/.so/.dylib). */
  export function getLoadablePath(): string;

  /**
   * Load the sqlite-vec extension into an open DatabaseSync instance.
   * The database MUST have been created with `{ allowExtension: true }`.
   */
  export function load(db: DatabaseSync): void;
}
