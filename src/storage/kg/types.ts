export interface FileInfo {
  id: number;
  path: string;
  relativePath: string;
  language: string;
  sizeBytes: number;
  hash: string;
  agentTouched: boolean;
  agentTouchedBy: string | null;
  agentTouchedAt: string | null;
  cognitiveLoad: number;
  lastScanned: string;
  lastSynced: string;
  patterns: string[];
}

export interface MemoryEntry {
  id: number;
  sessionId: number;
  scope: string;
  key: string;
  value: unknown;
  createdAt: string;
}

export interface AgentSession {
  id: number;
  agentName: string;
  startedAt: string;
  endedAt: string | null;
  contextHash: string;
  decisions: CoherenceDecision[];
  fingerprint: AgentFingerprint;
}

export interface CoherenceDecision {
  id: number;
  fileId: number | null;
  codeHash: string;
  verdict: 'pass' | 'warn' | 'fail';
  confidence: number;
  reasoningTrace: string[];
  suggestions: string[];
  llmProvider: string;
  responseTimeMs: number;
  analyzedAt: string;
}

export interface AgentFingerprint {
  asyncPreference: number;
  typeStrictness: number;
  errorHandlingStyle: string;
  namingConvention: string;
  testPattern: string;
  favoriteAbstractions: string[];
}