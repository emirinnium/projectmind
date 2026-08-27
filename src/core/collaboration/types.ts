export type IntentType = 'read' | 'write' | 'refactor' | 'delete';

export interface IntentBroadcast {
  agentId: string;
  intentType: IntentType;
  targetFiles: string[];
  timestamp: number;
  sessionId?: string;
  description?: string;
}

export interface ConflictPrediction {
  hasConflict: boolean;
  conflictingAgents: string[];
  conflictingFiles: string[];
  riskLevel: 'low' | 'medium' | 'high';
  reasons: string[];
}
