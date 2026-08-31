export interface PredictedFailure {
  filePath: string;
  functionName: string;
  confidence: number;
  reason: string;
  suggestedFix: string;
  riskLevel?: 'low' | 'medium' | 'high' | 'critical';
}

export interface CodeChange {
  filePath: string;
  moduleName: string;
  changeType: 'add' | 'modify' | 'delete';
  crossModule: boolean;
  affectedFunctions?: string[];
  previousContent?: string;
  diffText?: string;
}

export interface ImpactReport {
  predictionId: string;
  change: CodeChange;
  predictedImpact: number; // 0-1 scale
  confidenceScores: Record<string, number>;
  totalConfidence: number; // normalized to 1
  affectedModules: string[];
  timestamp: string;
}

export interface ActualImpact {
  predictionId: string;
  filePath: string;
  actualAffectedFiles: number;
  actualAffectedModules: string[];
  failureOccurred: boolean;
  severity: 'low' | 'medium' | 'high';
}

export interface PredictorConfig {
  bayesianPrior: number;
  crossModuleWeight: number;
  confidenceThreshold: number;
  modelUpdateRate: number;
}
