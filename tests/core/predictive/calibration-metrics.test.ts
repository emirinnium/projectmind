import { describe, expect, it } from 'vitest';
import { calculateRiskCalibration } from '@/core/predictive/calibration-metrics.js';

describe('risk calibration metrics', () => {
  it('calculates a deterministic Brier score and calibration bins', () => {
    const report = calculateRiskCalibration([
      { id: 'a', predictedProbability: 0.1, failureOccurred: false },
      { id: 'b', predictedProbability: 0.9, failureOccurred: true },
      { id: 'c', predictedProbability: 0.6, failureOccurred: false },
      { id: 'd', predictedProbability: 0.4, failureOccurred: true },
    ]);

    expect(report).toMatchObject({
      observations: 4,
      failures: 2,
      meanPredicted: 0.5,
      observedFailureRate: 0.5,
      brierScore: 0.185,
    });
    expect(report.bins).toHaveLength(5);
    expect(report.bins[0]).toMatchObject({ observations: 1, meanPredicted: 0.1 });
    expect(report.bins[4]).toMatchObject({ observations: 1, observedFailureRate: 1 });
  });

  it('does not claim calibration for an empty corpus', () => {
    expect(calculateRiskCalibration([])).toMatchObject({
      observations: 0,
      failures: 0,
      brierScore: 0,
      limitations: [expect.stringContaining('No labeled historical outcomes')],
    });
  });

  it('rejects malformed or out-of-range probability observations', () => {
    expect(() =>
      calculateRiskCalibration([{ id: 'bad', predictedProbability: 1.1, failureOccurred: false }]),
    ).toThrow();
  });
});
