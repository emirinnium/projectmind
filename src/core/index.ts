// Unified Core Services Barrel
// Re-exports all core domain modules for convenient importing

// Coherence Engine
export { CoherenceEngine } from './coherence/engine.js';
export type { LLMProvider, CoherenceResult, CoherenceCheckOptions } from './coherence/engine.js';

// Debt Tracker
export { DebtTracker } from './debt/tracker.js';
export type { DebtItem, DebtReport, DebtType, Severity } from './debt/tracker.js';

// Scale Manager
export { ScaleManager } from './scale/manager.js';
export type { ModuleInfo, ScaleReport, AgentProfile } from './scale/manager.js';

// Contracts Engine
export { ContractEngine } from './contracts/engine.js';
export type { ArchitecturalContract, ContractViolation } from './contracts/engine.js';

// LLM Providers
export { createLLMProvider, DEFAULT_TIMEOUT_MS } from './llm/index.js';
export type {
  LLMConfig,
  LLMProvider as LLMProviderInterface,
  LLMResponse as LLMResponseInterface,
} from './llm/index.js';
export { AnthropicProvider } from './llm/anthropic.js';
export { OpenAIProvider } from './llm/openai.js';
export { OllamaProvider } from './llm/ollama.js';
export { GeminiProvider } from './llm/gemini.js';
export { GroqProvider } from './llm/groq.js';

// Optional remote backends. These adapters are never constructed by default;
// SQLite/SQLite-vec remains the offline installation path.
export { QdrantVectorStore, QdrantOptionsSchema, RemoteBackendError } from './backends/qdrant.js';
export type {
  QdrantOptions,
  QdrantVectorStoreOptions,
  RemoteFetch,
  RemoteFetchInit,
  RemoteHttpResponse,
} from './backends/qdrant.js';
export { MemgraphGraphStore, MemgraphOptionsSchema } from './backends/memgraph.js';
export type {
  CypherDriverLike,
  CypherRecordLike,
  CypherResultLike,
  CypherSessionLike,
  MemgraphGraphStoreOptions,
} from './backends/memgraph.js';
export type { AsyncGraphStore, AsyncVectorStore } from './backends/contracts.js';

// Calibrated impact risk
export { calculateCalibratedRisk, collectRiskSignals } from './predictive/calibrated-risk.js';
export type {
  RiskSignals,
  RiskEvidence,
  CalibratedRiskAssessment,
  RiskSignalCollectionInput,
} from './predictive/calibrated-risk.js';
export {
  calculateRiskCalibration,
  riskCalibrationObservationSchema,
} from './predictive/calibration-metrics.js';
export type {
  RiskCalibrationObservation,
  RiskCalibrationBin,
  RiskCalibrationReport,
} from './predictive/calibration-metrics.js';
export { buildExploitPathReport } from './predictive/exploit-path.js';
export type {
  ExploitPathLocation,
  ExploitPathStep,
  ExploitPathCandidate,
  ExploitPathReport,
} from './predictive/exploit-path.js';
export { buildBugSurfaceReport } from './predictive/bug-surface.js';
export type {
  BugSurfaceSignals,
  BugSurfaceItem,
  BugSurfaceReport,
  BugSurfaceOptions,
} from './predictive/bug-surface.js';
export {
  AgentReplayStore,
  compareReplayEvent,
  summarizeReplayTimeline,
} from './replay/agent-replay.js';
export { reconstructContext } from './replay/context-reconstruction.js';
export type {
  ContextReconstruction,
  ContextReconstructionStatus,
  ReconstructedContextFile,
} from './replay/context-reconstruction.js';
export { recordEditDecision } from './refactor/audit.js';
export type { EditDecisionAuditInput, EditDecisionAuditReceipt } from './refactor/audit.js';
export { recordContextDecision } from './context/audit.js';
export type { ContextDecisionAuditInput, ContextDecisionAuditReceipt } from './context/audit.js';
export type {
  ReplayEventType,
  ReplayStatus,
  ReplayEventInput,
  ReplayEvent,
  ReplayComparison,
  ReplayTimelineSummary,
} from './replay/agent-replay.js';

// Cache
export {
  AdvancedCache,
  CoherenceCache,
  EmbeddingCache,
  CacheRegistry,
  globalCacheRegistry,
} from './cache/index.js';
export type { CacheEntry, CacheStats, CacheOptions } from './cache/types.js';

// Context Window Budget Optimizer
export {
  ContextBudgetOptimizer,
  createFullFilePlan,
  applyTaskTypeBoosts,
  taskTypeMultiplier,
  deriveInclusionReason,
} from './context/budget-optimizer.js';
export type {
  ContextItem,
  ContextBudgetPlan,
  BudgetOptimizerConfig,
  PlannedFile,
  ExcludedFileEntry,
  ContextTaskType,
} from './context/types.js';
export { calculateContextRoi, compareContextPlans } from './context/roi.js';
export type {
  ContextPlanComparison,
  ContextPlanVariant,
  ContextPlanVariantInput,
  ContextRoi,
  ContextRoiOptions,
} from './context/roi.js';
export { assessContextPricing } from './context/pricing.js';
export type {
  ContextPricingRecord,
  ContextPricingAssessment,
  ContextPricingStatus,
} from './context/pricing.js';
export {
  greedySelector,
  dpSelector,
  dpApplicable,
  DP_VALUE_SCALE,
  DP_MAX_RELEVANCE,
  DP_MAX_ITEMS,
  DP_TOTAL_VALUE_CAP,
} from './context/knapsack.js';
export type { SelectionResult } from './context/knapsack.js';

// Context Assemblers
export {
  assembleUserContext,
  UserContextItem,
  UserContextResult,
} from './context/user-context-assembler.js';
export {
  assembleSystemContext,
  SystemContextItem,
  SystemContextResult,
} from './context/system-context-assembler.js';

// Skills
export { SKILL_CATALOG } from './skills/engine.js';
export type { SkillDefinition, SkillEvidence, SkillGap } from './skills/engine.js';
export { AgentFingerprintExtractor, fingerprintExtractor } from './skills/fingerprint.js';
export { pseudonymizeAgentId } from './skills/engine.js';
export type { FileEdit } from './skills/fingerprint.js';
export type { AgentFingerprint } from '../storage/kg/types.js';
export {
  persistAgentProfile,
  loadAgentProfile,
  extractFingerprintFromContent,
} from './skills/engine.js';

// Memory
export { searchTeamMemoriesSemantic } from './memory/semantic-memory.js';
export type { SemanticMemoryHit, SemanticMemoryOptions } from './memory/semantic-memory.js';
export {
  recordSessionEvent,
  getSessionInsights,
  SESSION_EVENT_TYPES,
} from './intelligence/session-learner.js';
export { answerCodebaseQuestion } from './intelligence/qa-engine.js';
export type {
  CodebaseQuestionType,
  CodebaseQuestionEvidence,
  CodebaseAnswer,
  CodebaseQuestionOptions,
} from './intelligence/qa-engine.js';
export type {
  SessionEventType,
  SessionEventInput,
  SessionEventReceipt,
  SessionFileInsight,
  SessionToolInsight,
  SessionOutcomeInsight,
  SessionInsights,
  SessionInsightsOptions,
} from './intelligence/session-learner.js';

// Team Memory
export { threeWayMerge, diffHunks } from './team-memory/merge.js';
export type { DiffHunk, MergeConflict, MergeResult } from './team-memory/merge.js';

// Coordination
export { analyzeMergeContents, predictMergeRisk } from './coordination/risk.js';
export type {
  ConflictRiskInput,
  ConflictRisk,
  MergeContentChange,
  MergeContentAnalysis,
  MergeContentConflict,
} from './coordination/risk.js';
export { arbitrateAgents } from './coordination/arbiter.js';
export type {
  ArbitrateAgentsInput,
  ArbitrateAgentsReport,
  ArbiterAgentPlan,
  ArbiterAgentRisk,
  ArbiterConflictGroup,
  ArbiterDependencyEdge,
  ArbiterPairRisk,
  ArbiterShardSuggestion,
} from './coordination/arbiter.js';

// Embeddings
export { VectorIndex, VecIndex } from './embeddings/vector-index.js';

// Dedup
export { CloneDetector } from './dedup/clone-detector.js';
export type { CloneDetectionOptions, CloneDetectionResult } from './dedup/clone-detector.js';

// Refactor
export { AutoFixEngine } from './refactor/auto-fix.js';
export type { AutoFixResult, FixerMeta } from './refactor/auto-fix.js';
export { AutoFixFeedbackStore, sourceHashForContent } from './refactor/autofix-feedback.js';
export type {
  AutoFixFeedbackValue,
  AutoFixFeedbackInput,
  AutoFixFeedbackRecord,
  AutoFixRecommendation,
  AutoFixRecommendationStatus,
  AutoFixFeedbackReset,
} from './refactor/autofix-feedback.js';

// Evidence ledger
export {
  EvidenceLedger,
  computeIndexedGraphHash,
  summarizeLedgerInvocation,
  ledgerEventSchema,
  verifyLedgerExport,
} from './ledger/evidence-ledger.js';
export type {
  EvidenceLedgerExport,
  EvidenceLedgerRecord,
  LedgerEventInput,
  LedgerEventType,
  LedgerIssue,
  LedgerListOptions,
  LedgerVerification,
} from './ledger/evidence-ledger.js';

// Predictive Impact Analysis
export { ImpactPredictor } from './predictive/impact-predictor.js';
export type {
  CodeChange,
  ImpactReport,
  ActualImpact,
  PredictorConfig,
  PredictedFailure,
} from './predictive/types.js';

// Watcher
export { ProjectWatcher } from './watcher.js';
export type { ProjectWatcherOptions, WatcherStats, WatcherBatchResult } from './watcher.js';
export { ArchitectureGuardian } from './architecture/guardian.js';
export type { ArchitectureGuardianDecision } from './architecture/guardian.js';

// Knowledge Graph Integrity Guard
export {
  IntegrityGuard,
  parseGitRenameLog,
  INTEGRITY_EXCLUDED_DIRS,
} from './kg/integrity-guard.js';
export type { ParsedRenameLog } from './kg/integrity-guard.js';
export type {
  IntegrityViolation,
  RepairAction,
  IntegrityReport,
  IntegrityEvidenceStatus,
  IntegritySuggestedAction,
} from './kg/types.js';

// Intent-Driven Semantic Navigation (Hybrid RAG)
export { IntentEngine } from './search/intent-engine.js';
export type {
  IntentQuery,
  IntentType,
  HybridScore,
  SearchResult,
  SemanticEvidence,
  TaskType,
} from './search/types.js';
export { classifyTask, TASK_KEYWORDS, createKgGraphAdapter } from './search/intent-engine.js';
export type { KGGraphLike, KgAdapterSource } from './search/intent-engine.js';
export {
  rankHybrid,
  lexicalRelevance,
  normalizeHybridRankingWeights,
  DEFAULT_HYBRID_RANKING_WEIGHTS,
} from './search/hybrid-ranking.js';
export type {
  HybridRankingInput,
  HybridRankingOutput,
  HybridRankingWeights,
} from './search/hybrid-ranking.js';
export { HistoryRanker } from './search/history-ranking.js';
export type { HistoryScoreOptions } from './search/history-ranking.js';
export {
  LearnedSearchReranker,
  featuresFromSearchResult,
  SEARCH_RANKING_FEATURE_NAMES,
} from './search/learned-reranker.js';
export type {
  SearchRankingFeatures,
  SearchFeedback,
  RecordSearchFeedbackInput,
  SearchRerankCandidate,
  SearchRerankResult,
  SearchRankerStatus,
  LearnedRerankerOptions,
} from './search/learned-reranker.js';
export { selectCanonicalExample, sourceHash } from './search/canonical-example.js';
export type {
  CanonicalExampleCandidate,
  CanonicalExampleSelection,
} from './search/canonical-example.js';
export { resolveProjectRoot } from './project/roots.js';
export { getWorktreeIdentity } from './project/worktree-identity.js';
export {
  recordWorktreeIdentity,
  getWorktreeNamespaceStatus,
  listWorktreeIdentities,
  pruneWorktreeIdentities,
} from './project/index-identity.js';
export type { StoredWorktreeIdentity } from './project/index-identity.js';

export { buildReviewGraphClosure } from './review/graph-closure.js';
export type {
  ReviewGraphClosure,
  ReviewGraphClosureNode,
  ReviewGraphClosureOptions,
  ReviewGraphFile,
  ReviewGraphImport,
  ReviewGraphSource,
} from './review/graph-closure.js';
export { executeReviewBundles } from './review/bundle-workers.js';
export type {
  ReviewBundleExecution,
  ReviewBundleExecutionOptions,
  ReviewBundleExecutionResult,
  ReviewBundleWorker,
  ReviewBundleWorkerContext,
} from './review/bundle-workers.js';
export {
  BackendDescriptorSchema,
  BackendKindSchema,
  parseBackendDescriptor,
} from './backends/contracts.js';
export type {
  BackendDescriptor,
  BackendKind,
  GraphNodeRecord,
  GraphEdgeRecord,
  GraphStore,
  VectorMatch,
  VectorStore,
  ProjectFreshness,
  ProjectIndex,
} from './backends/contracts.js';
export {
  validateProjectPath,
  assertProjectPath,
  PathSecurityError,
} from './security/path-security.js';
export type {
  PathSecurityCode,
  PathSecurityOptions,
  PathSecurityResult,
} from './security/path-security.js';
export { readSourceRange } from './retrieval/byte-range.js';
export type { SourceRangeResult } from './retrieval/byte-range.js';
export {
  rebuildSourceRangeIndex,
  listIndexedSourceRanges,
  readSourceSymbolRange,
} from './retrieval/source-index.js';
export type {
  IndexedSourceRange,
  SourceRangeKind,
  SourceSymbolRangeResult,
} from './retrieval/source-index.js';
export { applySurgicalEdit, makeSurgicalEditPlan } from './refactor/surgical-edit.js';
export type { SurgicalEditPlan, SurgicalEditResult } from './refactor/surgical-edit.js';
export { runPostEditGate } from './refactor/post-edit-gate.js';
export type {
  PostEditGateCheck,
  PostEditGateOptions,
  PostEditGateReport,
  PostEditGateStatus,
} from './refactor/post-edit-gate.js';

// Cross-Project Pattern Learning (F4)
export {
  CrossProjectPatternEngine,
  normalizeAbstractionLevel,
  buildPattern,
  defaultSuccessMetrics,
  extractionConfidence,
  templateFromCodeHash,
  computeBagOfWordsEmbedding,
  LEGACY_ABSTRACTION_LEVEL_MAP,
} from './patterns/cross-project.js';
export type { CrossProjectPatternEngineOptions } from './patterns/cross-project.js';
export type {
  LearnedPattern,
  PatternVariant,
  PatternGraph,
  AbstractionLevel,
  LegacyAbstractionLevel,
  AbstractionLevelInput,
  PatternMatch,
  PatternSuccessMetrics,
  AbstractTemplate,
} from './patterns/types.js';

// Real-Time Collaborative Agent Context (Live Intent Broadcast + Conflict Prediction)
export {
  IntentBroadcastService,
  DEFAULT_TTL_SECONDS,
  DEFAULT_PRIVATE_BRANCH_PATTERNS,
} from './collaboration/broadcast.js';
export type { IntentBroadcastOptions } from './collaboration/broadcast.js';
export type {
  IntentBroadcast,
  ConflictPrediction,
  ExpectedChanges,
  ExpectedSignatureChange,
  ExpectedTypeChange,
  IntentScope,
} from './collaboration/types.js';

// Evidence-first verification and graph freshness
export {
  attachEvidence,
  buildEvidencePacket,
  insufficientEvidencePacket,
  verifyFileFreshness,
  verifyProjectFreshness,
} from './proof/evidence.js';
export type {
  EvidenceAttached,
  EvidenceKind,
  EvidencePacket,
  EvidenceReference,
  FileFreshness,
  FreshnessStatus,
  FreshnessSummary,
  VerificationDetails,
  VerificationStatus,
} from './proof/evidence.js';

// Portable graph snapshots for drift detection and reproducible analysis.
export {
  createGraphSnapshot,
  diffGraphSnapshots,
  readGraphSnapshot,
  verifyGraphSnapshot,
  writeGraphSnapshot,
  GRAPH_SNAPSHOT_FORMAT,
  GRAPH_SNAPSHOT_VERSION,
} from './snapshots/graph-snapshot.js';
export type {
  GraphSnapshot,
  GraphSnapshotCall,
  GraphSnapshotDiff,
  GraphSnapshotFile,
  GraphSnapshotImport,
  GraphSnapshotVerification,
} from './snapshots/graph-snapshot.js';

// Deterministic feature candidates and cross-feature import flows.
export { buildFeatureMap, featureKeyForPath } from './feature-map/feature-map.js';
export type { FeatureCandidate, FeatureFlow, FeatureMapReport } from './feature-map/feature-map.js';

// Runtime trace adapters for normalized JSON/CSV, Code-Graph-RAG JSONL, and V8 profiles.
export { convertTraceContent } from './trace/converter.js';
export type {
  NormalizedTraceEvent,
  TraceConversionFormat,
  TraceConversionResult,
} from './trace/converter.js';
