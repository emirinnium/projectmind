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
  decisions: any;
  fingerprint: any;
}