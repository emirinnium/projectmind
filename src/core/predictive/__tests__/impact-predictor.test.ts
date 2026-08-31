import { describe, it, expect } from 'vitest';
import { ImpactPredictor } from '../impact-predictor.js';
import type { PredictedFailure, PredictorConfig } from '../types.js';

const DEFAULT_CONFIG: PredictorConfig = {
  bayesianPrior: 0.5,
  crossModuleWeight: 0.8,
  confidenceThreshold: 0.7,
  modelUpdateRate: 0.1,
};

describe('ImpactPredictor', () => {
  describe('computeRiskLevel', () => {
    it('returns low for few low-confidence failures', () => {
      const predictor = new ImpactPredictor(DEFAULT_CONFIG);
      const failures: PredictedFailure[] = [
        { filePath: 'a.ts', functionName: 'foo', confidence: 0.2, reason: 'r', suggestedFix: 'f' },
        { filePath: 'a.ts', functionName: 'bar', confidence: 0.1, reason: 'r', suggestedFix: 'f' },
      ];
      expect(predictor.computeRiskLevel(failures)).toBe('low');
    });

    it('returns low for empty failures array', () => {
      const predictor = new ImpactPredictor(DEFAULT_CONFIG);
      expect(predictor.computeRiskLevel([])).toBe('low');
    });

    it('returns medium for 3 or more low-confidence failures', () => {
      const predictor = new ImpactPredictor(DEFAULT_CONFIG);
      const failures: PredictedFailure[] = [
        { filePath: 'a.ts', functionName: 'a', confidence: 0.2, reason: 'r', suggestedFix: 'f' },
        { filePath: 'a.ts', functionName: 'b', confidence: 0.3, reason: 'r', suggestedFix: 'f' },
        { filePath: 'a.ts', functionName: 'c', confidence: 0.1, reason: 'r', suggestedFix: 'f' },
      ];
      expect(predictor.computeRiskLevel(failures)).toBe('medium');
    });

    it('returns high for a high-confidence failure (>= 0.7)', () => {
      const predictor = new ImpactPredictor(DEFAULT_CONFIG);
      const failures: PredictedFailure[] = [
        { filePath: 'a.ts', functionName: 'foo', confidence: 0.8, reason: 'r', suggestedFix: 'f' },
      ];
      expect(predictor.computeRiskLevel(failures)).toBe('high');
    });

    it('returns high for 10 or more failures even if all low confidence', () => {
      const predictor = new ImpactPredictor(DEFAULT_CONFIG);
      const failures: PredictedFailure[] = Array.from({ length: 10 }, (_, i) => ({
        filePath: 'a.ts',
        functionName: `fn${i}`,
        confidence: 0.1,
        reason: 'r',
        suggestedFix: 'f',
      }));
      expect(predictor.computeRiskLevel(failures)).toBe('high');
    });

    it('returns critical for a critical-confidence failure (>= 0.9)', () => {
      const predictor = new ImpactPredictor(DEFAULT_CONFIG);
      const failures: PredictedFailure[] = [
        { filePath: 'a.ts', functionName: 'foo', confidence: 0.95, reason: 'r', suggestedFix: 'f' },
      ];
      expect(predictor.computeRiskLevel(failures)).toBe('critical');
    });

    it('returns critical for 20 or more failures', () => {
      const predictor = new ImpactPredictor(DEFAULT_CONFIG);
      const failures: PredictedFailure[] = Array.from({ length: 20 }, (_, i) => ({
        filePath: 'a.ts',
        functionName: `fn${i}`,
        confidence: 0.1,
        reason: 'r',
        suggestedFix: 'f',
      }));
      expect(predictor.computeRiskLevel(failures)).toBe('critical');
    });

    it('returns critical when both high and critical confidence failures exist', () => {
      const predictor = new ImpactPredictor(DEFAULT_CONFIG);
      const failures: PredictedFailure[] = [
        { filePath: 'a.ts', functionName: 'a', confidence: 0.75, reason: 'r', suggestedFix: 'f' },
        { filePath: 'a.ts', functionName: 'b', confidence: 0.92, reason: 'r', suggestedFix: 'f' },
      ];
      expect(predictor.computeRiskLevel(failures)).toBe('critical');
    });
  });

  describe('predictTestBreaks riskLevel assignment', () => {
    it('assigns riskLevel to each failure in the returned array', () => {
      const predictor = new ImpactPredictor(DEFAULT_CONFIG);
      // Use a non-existent file path — simulateDiff will return empty diff,
      // so predictTestBreaks returns empty array with no riskLevel assigned.
      // To test riskLevel assignment we need actual changed functions.
      // We test with previousContent to force a diff.
      const failures = predictor.predictTestBreaks({
        filePath: 'src/core/predictive/impact-predictor.ts',
        moduleName: 'predictive',
        changeType: 'modify',
        crossModule: false,
        previousContent: 'export class ImpactPredictor {}',
      });
      // Each failure should have riskLevel defined (string) when there are failures
      for (const failure of failures) {
        expect(typeof failure.riskLevel).toBe('string');
        expect(['low', 'medium', 'high', 'critical']).toContain(failure.riskLevel);
      }
    });
  });
});
