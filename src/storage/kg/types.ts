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

/**
 * Error-handling style labels exactly as emitted by the fingerprint
 * classifier (src/core/skills/fingerprint.ts — classifyErrorHandling).
 */
export const ERROR_HANDLING_STYLES = ['try-catch', 'result-type', 'throw', 'mixed'] as const;
export type ErrorHandlingStyle = (typeof ERROR_HANDLING_STYLES)[number];

/**
 * Naming-convention labels exactly as emitted by the fingerprint classifier
 * (dominantNaming). 'unknown' marks an unmeasured dimension (no classified
 * declarations); 'mixed' means no convention reached the 60% dominance bar.
 */
export const NAMING_CONVENTIONS = [
  'camelCase',
  'snake_case',
  'PascalCase',
  'SCREAMING_SNAKE',
  'mixed',
  'unknown',
] as const;
export type NamingConvention = (typeof NAMING_CONVENTIONS)[number];

/** Test-pattern labels exactly as emitted by classifyTestPattern. */
export const TEST_PATTERNS = ['none', 'bdd', 'unit', 'mixed'] as const;
export type TestPattern = (typeof TEST_PATTERNS)[number];

/**
 * Per-dimension measurement flags recorded alongside the fingerprint.
 * A dimension is "measured" only when the classifier saw at least one
 * relevant sample; unmeasured dimensions carry neutral defaults
 * (asyncPreference 0.5, namingConvention 'unknown', errorHandlingStyle
 * 'try-catch') that must NOT be compared as if they were real style signal.
 */
export interface FingerprintMeasured {
  /** At least one await expression or .then() chain was observed. */
  asyncPreference: boolean;
  /** At least one named declaration was classified for naming style. */
  namingConvention: boolean;
  /** At least one error-handling construct (try/throw/.catch/ok-err) seen. */
  errorHandlingStyle: boolean;
}

export interface AgentFingerprint {
  asyncPreference: number;
  typeStrictness: number;
  errorHandlingStyle: ErrorHandlingStyle;
  namingConvention: NamingConvention;
  testPattern: TestPattern;
  favoriteAbstractions: string[];
  /**
   * Optional measurement metadata. Absent on profiles persisted before this
   * field existed; consumers must treat missing metadata as "unmeasured" and
   * skip style comparisons rather than emit false warnings.
   */
  measured?: FingerprintMeasured;
}
