export type IntentType = 'read' | 'write' | 'refactor' | 'delete';

/** Structured expected change: a function signature rewrite. */
export interface ExpectedSignatureChange {
  function: string;
  oldSig: string;
  newSig: string;
}

/** Structured expected change: a type definition rewrite. */
export interface ExpectedTypeChange {
  type: string;
  oldDef: string;
  newDef: string;
}

/**
 * F17: machine-readable description of the changes an intent plans to make.
 * Callers that do not need structured entries may use free-form `notes`.
 */
export interface ExpectedChanges {
  signatureChanges?: ExpectedSignatureChange[];
  typeChanges?: ExpectedTypeChange[];
  /** Simple string entries for callers that don't need structured data. */
  notes?: string[];
}

/** Where an intent is visible. 'local' intents never leave this process. */
export type IntentScope = 'shared' | 'local';

export interface IntentBroadcast {
  /** Stable identity used for deduplication (stamped if not provided). */
  id?: string;
  agentId: string;
  intentType: IntentType;
  targetFiles: string[];
  /** Unix milliseconds when the intent was broadcast. */
  timestamp: number;
  sessionId?: string;
  description?: string;
  ttlSeconds?: number;
  /** F17: planned signature/type changes, persisted as JSON. */
  expectedChanges?: ExpectedChanges;
  /** F45: 'local' when sanitized (private branch) — in-memory only. */
  scope?: IntentScope;
}

export interface ConflictPrediction {
  hasConflict: boolean;
  conflictingAgents: string[];
  conflictingFiles: string[];
  riskLevel: 'low' | 'medium' | 'high';
  reasons: string[];
}
