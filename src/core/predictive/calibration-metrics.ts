import { z } from 'zod';

export const riskCalibrationObservationSchema = z
  .object({
    id: z.string().trim().min(1).max(200),
    predictedProbability: z.number().finite().min(0).max(1),
    failureOccurred: z.boolean(),
  })
  .strict();

export type RiskCalibrationObservation = z.infer<typeof riskCalibrationObservationSchema>;

export interface RiskCalibrationBin {
  lower: number;
  upper: number;
  observations: number;
  meanPredicted: number | null;
  observedFailureRate: number | null;
  absoluteGap: number | null;
}

export interface RiskCalibrationReport {
  observations: number;
  failures: number;
  meanPredicted: number;
  observedFailureRate: number;
  brierScore: number;
  bins: RiskCalibrationBin[];
  limitations: string[];
}

const BIN_COUNT = 5;

function rounded(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/**
 * Evaluate probability forecasts against explicit historical outcomes.
 * This is intentionally a pure metric, not a trainer: an empty or unlabeled
 * corpus returns an honest zero-observation report with no accuracy claim.
 */
export function calculateRiskCalibration(
  input: readonly RiskCalibrationObservation[],
): RiskCalibrationReport {
  const observations = input.map((item) => riskCalibrationObservationSchema.parse(item));
  const failures = observations.filter((item) => item.failureOccurred).length;
  const meanPredicted = observations.length
    ? rounded(
        observations.reduce((sum, item) => sum + item.predictedProbability, 0) /
          observations.length,
      )
    : 0;
  const observedFailureRate = observations.length ? rounded(failures / observations.length) : 0;
  const brierScore = observations.length
    ? rounded(
        observations.reduce(
          (sum, item) => sum + (item.predictedProbability - (item.failureOccurred ? 1 : 0)) ** 2,
          0,
        ) / observations.length,
      )
    : 0;
  const bins: RiskCalibrationBin[] = Array.from({ length: BIN_COUNT }, (_, index) => {
    const lower = index / BIN_COUNT;
    const upper = (index + 1) / BIN_COUNT;
    const members = observations.filter(
      (item) =>
        item.predictedProbability >= lower &&
        (index === BIN_COUNT - 1
          ? item.predictedProbability <= upper
          : item.predictedProbability < upper),
    );
    if (members.length === 0) {
      return {
        lower,
        upper,
        observations: 0,
        meanPredicted: null,
        observedFailureRate: null,
        absoluteGap: null,
      };
    }
    const mean = members.reduce((sum, item) => sum + item.predictedProbability, 0) / members.length;
    const observed = members.filter((item) => item.failureOccurred).length / members.length;
    return {
      lower,
      upper,
      observations: members.length,
      meanPredicted: rounded(mean),
      observedFailureRate: rounded(observed),
      absoluteGap: rounded(Math.abs(mean - observed)),
    };
  });
  return {
    observations: observations.length,
    failures,
    meanPredicted,
    observedFailureRate,
    brierScore,
    bins,
    limitations:
      observations.length === 0
        ? ['No labeled historical outcomes were provided; no calibration claim was made.']
        : [
            'Calibration measures the supplied predictions against supplied labels; it does not prove causation or future deployment safety.',
            'Results are only representative of the repository, time window, and labeling policy used to build the corpus.',
          ],
  };
}
