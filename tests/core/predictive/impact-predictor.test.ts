import { describe, it, expect } from 'vitest';
import { ImpactPredictor } from '../../../src/core/predictive/impact-predictor.js';
import type { CodeChange, ActualImpact } from '../../../src/core/predictive/types.js';

describe('ImpactPredictor', () => {
  it('returns no impact for empty change', () => {
    const predictor = new ImpactPredictor({
      bayesianPrior: 0.5,
      crossModuleWeight: 0.8,
      confidenceThreshold: 0.7,
      modelUpdateRate: 0.1,
    });
    const change: CodeChange = {
      filePath: '',
      moduleName: '',
      changeType: 'modify',
      crossModule: false,
    };
    const report = predictor.predictImpact(change);
    expect(report.predictedImpact).toBeGreaterThanOrEqual(0);
    expect(report.totalConfidence).toBeCloseTo(1, 2);
    const scores = Object.values(report.confidenceScores);
    const sum = scores.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 2);
  });

  it('produces high confidence for cross-module change', () => {
    const predictor = new ImpactPredictor({
      bayesianPrior: 0.5,
      crossModuleWeight: 0.8,
      confidenceThreshold: 0.7,
      modelUpdateRate: 0.1,
    });
    const change: CodeChange = {
      filePath: 'src/core/index.ts',
      moduleName: 'core',
      changeType: 'modify',
      crossModule: true,
    };
    const report = predictor.predictImpact(change);
    expect(report.confidenceScores.crossModule).toBeGreaterThan(0.3);
    expect(report.totalConfidence).toBeCloseTo(1, 2);
    expect(report.predictedImpact).toBeGreaterThan(0.5);
  });

  it('updates model after recording outcome', () => {
    const predictor = new ImpactPredictor({
      bayesianPrior: 0.5,
      crossModuleWeight: 0.8,
      confidenceThreshold: 0.7,
      modelUpdateRate: 0.1,
    });
    const change: CodeChange = {
      filePath: 'src/core/index.ts',
      moduleName: 'core',
      changeType: 'modify',
      crossModule: true,
    };
    const report = predictor.predictImpact(change);
    const actual: ActualImpact = {
      predictionId: report.predictionId,
      actualAffectedFiles: 3,
      actualAffectedModules: ['core', 'cli'],
      failureOccurred: true,
      severity: 'high',
    };
    predictor.recordOutcome(report.predictionId, actual);
    expect(predictor.getOutcomeCount()).toBe(1);
    const weights = predictor.getModelWeights();
    expect(weights.has('crossModule')).toBe(true);
  });
});
