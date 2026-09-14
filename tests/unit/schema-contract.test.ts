import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { SCHEMA_SQL } from '../../src/storage/schema.js';

describe('base schema contracts', () => {
  it('defines all data-flow scope and language columns before migrations', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(SCHEMA_SQL);
    const columns = db
      .prepare('PRAGMA table_info(data_flows)')
      .all() as Array<{ name: string; notnull: number; dflt_value: string | null }>;
    const byName = new Map(columns.map((column) => [column.name, column]));

    expect(byName.get('project_id')).toMatchObject({ notnull: 1, dflt_value: '1' });
    expect(byName.has('source_language')).toBe(true);
    expect(byName.has('target_language')).toBe(true);
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_data_flows_project'")
        .get(),
    ).toBeTruthy();
    db.close();
  });
});
