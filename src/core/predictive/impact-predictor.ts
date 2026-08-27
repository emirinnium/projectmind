import type { CodeChange, ImpactReport, ActualImpact, PredictorConfig } from './types.js';

export class ImpactPredictor {
  private config: PredictorConfig;
  private modelWeights: Map<string, number> = new Map();
  private outcomes: ActualImpact[] = [];

  constructor(config: PredictorConfig) {
    this.config = config;
    this.modelWeights.set('crossModule', config.crossModuleWeight);
    this.modelWeights.set('prior', config.bayesianPrior);
  }

  predictImpact(change: CodeChange): ImpactReport {
    const predictionId = `pred-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    // Bayesian-style prediction: combine prior with cross-module signal
    let rawCross = change.crossModule ? this.config.crossModuleWeight : 0.1;
    let rawPrior = this.config.bayesianPrior;

    const scores: Record<string, number> = {
      crossModule: rawCross,
      prior: rawPrior,
      changeType: change.changeType === 'modify' ? 0.7 : 0.3,
    };

    // Normalize confidence scores to sum to 1
    const totalRaw = Object.values(scores).reduce((a, b) => a + b, 0);
    const normalized: Record<string, number> = {};
    for (const [k, v] of Object.entries(scores)) {
      normalized[k] = totalRaw > 0 ? v / totalRaw : 0;
    }

    const totalConfidence = Object.values(normalized).reduce((a, b) => a + b, 0);
    // Ensure exactly 1 after floating-point arithmetic
    const correctedTotal = Math.abs(totalConfidence - 1) < 0.001 ? 1 : totalConfidence;

    const predictedImpact = Math.min(1, (rawCross + rawPrior) / 2);
    const affectedModules = change.crossModule ? ['core', 'cli', 'storage'] : [change.moduleName];

    return {
      predictionId,
      change,
      predictedImpact,
      confidenceScores: normalized,
      totalConfidence: correctedTotal,
      affectedModules,
      timestamp: new Date().toISOString(),
    };
  }

  recordOutcome(predictionId: string, actual: ActualImpact): void {
    this.outcomes.push(actual);
    // Update model weights based on outcome (Bayesian update approximation)
    const error = actual.failureOccurred ? 0.2 : -0.05;
    const currentCross = this.modelWeights.get('crossModule') ?? this.config.crossModuleWeight;
    this.modelWeights.set('crossModule', Math.max(0.1, Math.min(1, currentCross + error * this.config.modelUpdateRate)));
  }

  getModelWeights(): Map<string, number> {
    return new Map(this.modelWeights);
  }

  getOutcomeCount(): number {
    return this.outcomes.length;
  }
}
