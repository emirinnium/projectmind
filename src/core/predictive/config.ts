import type { PredictorConfig } from './types.js';

/**
 * Default PredictorConfig shared across all commands that use ImpactPredictor.
 * Centralizes the configuration to reduce duplication and ensure consistency.
 */
export const DEFAULT_PREDICTOR_CONFIG: PredictorConfig = {
  bayesianPrior: 0.5,
  crossModuleWeight: 0.8,
  confidenceThreshold: 0.7,
  modelUpdateRate: 0.1,
};
