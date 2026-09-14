import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  calculateCalibratedRisk,
  collectRiskSignals,
  type RiskSignals,
} from '@/core/predictive/calibrated-risk.js';

function makeSignals(overrides: Partial<RiskSignals> = {}): RiskSignals {
  return {
    filePath: 'src/auth.ts',
    indexed: true,
    directDependents: 2,
    affectedModules: 1,
    changedFunctions: 1,
    changedTypes: 0,
    churnCommits: 2,
    debt: { high: 0, medium: 1, low: 0 },
    historicalFailures: 0,
    historicalObservations: 0,
    ...overrides,
  };
}

describe('calibrated risk', () => {
  it('keeps uncertainty wide when historical calibration data is insufficient', () => {
    const result = calculateCalibratedRisk(makeSignals());

    expect(result.status).toBe('insufficient-data');
    expect(result.confidenceInterval).toEqual({ lower: 0, upper: 1, level: 0.95 });
    expect(result.confidence).toBe(0);
    expect(result.calibration.empiricallyCalibrated).toBe(false);
    expect(result.uncertainty.some((item) => item.includes('No historical'))).toBe(true);
    expect(result.evidence.map((item) => item.signal)).toContain('direct-dependents');
  });

  it('uses deterministic beta updating after the minimum outcome count', () => {
    const signals = makeSignals({ historicalFailures: 7, historicalObservations: 12 });
    const first = calculateCalibratedRisk(signals);
    const second = calculateCalibratedRisk(signals);

    expect(first).toEqual(second);
    expect(first.status).toBe('estimated');
    expect(first.calibration.empiricallyCalibrated).toBe(true);
    expect(first.calibration.observations).toBe(12);
    expect(first.calibration.failures).toBe(7);
    expect(first.confidenceInterval.upper).toBeLessThan(1);
    expect(first.confidenceInterval.lower).toBeGreaterThan(0);
  });

  it('collects debt and recorded outcomes in the active project scope', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE debt_items (
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL,
        file_id INTEGER,
        severity TEXT NOT NULL,
        resolved INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE test_failure_log (
        id INTEGER PRIMARY KEY,
        file_path TEXT,
        failure_occurred INTEGER NOT NULL DEFAULT 0
      );
    `);
    db.prepare(
      'INSERT INTO debt_items (id, project_id, file_id, severity) VALUES (1, 7, 4, ?)',
    ).run('high');
    db.prepare(
      'INSERT INTO debt_items (id, project_id, file_id, severity) VALUES (2, 7, 4, ?)',
    ).run('low');
    db.prepare(
      'INSERT INTO debt_items (id, project_id, file_id, severity) VALUES (3, 8, 4, ?)',
    ).run('high');
    db.prepare(
      'INSERT INTO test_failure_log (id, file_path, failure_occurred) VALUES (1, ?, 1)',
    ).run('src/auth.ts');
    db.prepare(
      'INSERT INTO test_failure_log (id, file_path, failure_occurred) VALUES (2, ?, 0)',
    ).run('src/auth.ts');

    const signals = collectRiskSignals({
      db,
      graph: {
        getFileByPath: () => ({
          id: 4,
          path: 'C:/repo/src/auth.ts',
          relativePath: 'src/auth.ts',
          language: 'typescript',
          sizeBytes: 10,
          hash: 'hash',
          agentTouched: false,
          agentTouchedBy: null,
          agentTouchedAt: null,
          cognitiveLoad: 0,
          lastScanned: '',
          lastSynced: '',
          patterns: [],
        }),
        getDependents: () => [
          {
            id: 5,
            path: 'C:/repo/src/routes.ts',
            relativePath: 'src/routes.ts',
            language: 'typescript',
            sizeBytes: 10,
            hash: 'hash',
            agentTouched: false,
            agentTouchedBy: null,
            agentTouchedAt: null,
            cognitiveLoad: 0,
            lastScanned: '',
            lastSynced: '',
            patterns: [],
          },
        ],
      },
      projectId: 7,
      filePath: 'src/auth.ts',
      churnCommits: 3,
    });

    expect(signals.debt).toEqual({ high: 1, medium: 0, low: 1 });
    expect(signals.directDependents).toBe(1);
    expect(signals.historicalFailures).toBe(1);
    expect(signals.historicalObservations).toBe(2);
    db.close();
  });
});
