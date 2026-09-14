import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL } from '../../src/storage/schema.js';
import { runMigrations } from '../../src/storage/migrations.js';
import { ScaleReporter } from '../../src/core/scale/reporting/reporter.js';

describe('scan profile skipped-file observability', () => {
  it('persists oversized-file count and paths without losing older fields', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(SCHEMA_SQL);
    runMigrations(db);
    const kg = {
      db,
      getCurrentProjectId: () => 1,
      getAllFiles: () => [],
    } as never;
    const reporter = new ScaleReporter(kg);
    reporter.storeScanProfile({
      totalFiles: 3,
      scannedFiles: 2,
      errorFiles: 0,
      skippedFiles: 1,
      skippedPaths: ['assets/large.ts'],
      durationMs: 10,
      filesPerSecond: 200,
      memoryUsedMB: 1,
      errors: [],
    });

    expect(reporter.getLastScanProfile()).toMatchObject({
      skippedFiles: 1,
      skippedPaths: ['assets/large.ts'],
    });
    db.close();
  });
});
