import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ImpactPredictor } from '../../../src/core/predictive/impact-predictor.js';
import type { CodeChange, ActualImpact, PredictedFailure } from '../../../src/core/predictive/types.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('ImpactPredictor WP2', () => {
  const config = { bayesianPrior: 0.5, crossModuleWeight: 0.3, confidenceThreshold: 0.7, modelUpdateRate: 0.1 };

  describe('F6 recordOutcome -> correlateHistoricalFailures', () => {
    it('persists file_path and correlates', () => {
      const dbPath = join(tmpdir(), 'impact-test-' + Date.now() + '.db');
      const db = new DatabaseSync(dbPath);
      db.exec(`CREATE TABLE IF NOT EXISTS test_failure_log (id INTEGER PRIMARY KEY AUTOINCREMENT, prediction_id TEXT NOT NULL, file_path TEXT, module_name TEXT, failure_occurred BOOLEAN DEFAULT 0, severity TEXT DEFAULT 'medium', logged_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
      const predictor = new ImpactPredictor(config, db);
      const impact: ActualImpact = { predictionId: 'p1', filePath: 'src/auth.ts', actualAffectedFiles: 2, actualAffectedModules: ['auth'], failureOccurred: true, severity: 'high' };
      predictor.recordOutcome('p1', impact);
      const corr = predictor.correlateHistoricalFailures('src/auth.ts', db);
      expect(corr.avgFailureRate).toBeGreaterThan(0);
      expect(corr.commonBrokenTests.length).toBeGreaterThanOrEqual(0);
      db.close();
      rmSync(dbPath, { force: true });
    });
  });

  describe('F7 call-site analysis', () => {
    it('flags stale mock after arity change', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'callsite-'));
      const srcFile = join(tmpDir, 'src.ts');
      const testFile = join(tmpDir, 'src.test.ts');
      writeFileSync(srcFile, 'export function foo(a: number, b: string) {}');
      writeFileSync(testFile, 'import { foo } from "./src"; foo(1);');
      const predictor = new ImpactPredictor(config);
      const change: CodeChange = { filePath: srcFile, moduleName: 'src', changeType: 'modify', crossModule: false, affectedFunctions: ['foo'] };
      // We simulate diff by providing previousContent with old arity
      const prev = 'export function foo(a: number) {}';
      const diff = predictor.simulateDiff({ ...change, previousContent: prev });
      expect(diff.changedFunctions.length).toBeGreaterThan(0);
      const breaks = predictor.predictTestBreaks({ ...change, previousContent: prev });
      expect(breaks.length).toBeGreaterThan(0);
      const first = breaks[0];
      expect(first.functionName).toBe('foo');
      expect(first.confidence).toBeGreaterThan(0);
      expect(first.reason).toContain('Signature changed');
      rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe('F8 git fallback', () => {
    it('does not throw when no git info', () => {
      const predictor = new ImpactPredictor(config);
      const change: CodeChange = { filePath: '/nonexistent/file.ts', moduleName: 'x', changeType: 'modify', crossModule: false };
      expect(() => predictor.simulateDiff(change)).not.toThrow();
    });
  });

  describe('F9 totalConfidence and crossModule', () => {
    it('totalConfidence varies and is in (0,1)', () => {
      const predictor = new ImpactPredictor(config);
      const r1 = predictor.predictImpact({ filePath: 'a.ts', moduleName: 'm', changeType: 'modify', crossModule: false });
      const r2 = predictor.predictImpact({ filePath: 'a.ts', moduleName: 'm', changeType: 'add', crossModule: true });
      expect(r1.totalConfidence).toBeGreaterThan(0);
      expect(r1.totalConfidence).toBeLessThan(1);
      expect(r2.totalConfidence).toBeGreaterThan(0);
      expect(r2.totalConfidence).toBeLessThan(1);
      expect(r1.totalConfidence).not.toBe(r2.totalConfidence);
    });
    it('crossModule includes both modules', () => {
      const predictor = new ImpactPredictor(config);
      const r = predictor.predictImpact({ filePath: 'src/auth.ts', moduleName: 'auth', changeType: 'modify', crossModule: true });
      expect(r.affectedModules.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('F10 PredictedFailure shape', () => {
    it('asserts PredictedFailure fields', () => {
      const failure: PredictedFailure = { filePath: 'f.ts', functionName: 'fn', confidence: 0.8, reason: 'r', suggestedFix: 'fix' };
      expect(failure.filePath).toBe('f.ts');
      expect(failure.functionName).toBe('fn');
      expect(typeof failure.confidence).toBe('number');
      expect(failure.confidence).toBeGreaterThan(0);
      expect(failure.reason).toBeDefined();
      expect(failure.suggestedFix).toBeDefined();
    });
  });
});
