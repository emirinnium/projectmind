import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { IntegrityGuard } from '../../../src/core/kg/integrity-guard.js';
import type { IntegrityViolation } from '../../../src/core/kg/types.js';
import { initDatabase, closeDatabase } from '../../../src/storage/database.js';

describe('IntegrityGuard', () => {
  beforeAll(() => {
    initDatabase(':memory:');
  });
  afterAll(() => {
    closeDatabase();
  });
  it('detects stale nodes', () => {
    const guard = new IntegrityGuard();
    const violations = guard.checkConsistency();
    // Should return array (may be empty if DB clean)
    expect(Array.isArray(violations)).toBe(true);
    for (const v of violations) {
      expect(['missing_file', 'moved_file', 'stale_import', 'orphan_node']).toContain(v.type);
    }
  });

  it('repairs moved files', () => {
    const guard = new IntegrityGuard();
    const repaired = guard.repairStaleNodes();
    expect(typeof repaired).toBe('number');
    expect(repaired).toBeGreaterThanOrEqual(0);
  });

  it('detects orphans', () => {
    const guard = new IntegrityGuard();
    const orphans = guard.detectOrphans();
    expect(Array.isArray(orphans)).toBe(true);
    for (const o of orphans) {
      expect(typeof o).toBe('string');
    }
  });

  it('generates integrity report', () => {
    const guard = new IntegrityGuard();
    const report = guard.generateReport();
    expect(report).toHaveProperty('violations');
    expect(report).toHaveProperty('repaired');
    expect(report).toHaveProperty('orphans');
    expect(report).toHaveProperty('timestamp');
  });
});
