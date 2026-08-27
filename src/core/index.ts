// Unified Core Services Barrel
// Re-exports all core domain modules for convenient importing

// Coherence Engine
export { CoherenceEngine } from './coherence/engine.js';
export type { 
  LLMProvider, 
  CoherenceResult, 
  CoherenceCheckOptions 
} from './coherence/engine.js';

// Debt Tracker
export { DebtTracker } from './debt/tracker.js';
export type { 
  DebtItem, 
  DebtReport, 
  DebtType, 
  Severity 
} from './debt/tracker.js';

// Scale Manager
export { ScaleManager } from './scale/manager.js';
export type { 
  ModuleInfo, 
  ScaleReport, 
  AgentProfile 
} from './scale/manager.js';

// Contracts Engine
export { ContractEngine } from './contracts/engine.js';
export type { 
  ArchitecturalContract, 
  ContractViolation 
} from './contracts/engine.js';

// LLM Providers
export { createLLMProvider, DEFAULT_TIMEOUT_MS } from './llm/index.js';
export type { LLMConfig, LLMProvider as LLMProviderInterface, LLMResponse as LLMResponseInterface } from './llm/index.js';
export { AnthropicProvider } from './llm/anthropic.js';
export { OpenAIProvider } from './llm/openai.js';
export { OllamaProvider } from './llm/ollama.js';
export { GeminiProvider } from './llm/gemini.js';
export { GroqProvider } from './llm/groq.js';

// Cache
export { 
  AdvancedCache, 
  CoherenceCache, 
  EmbeddingCache, 
  CacheRegistry, 
  globalCacheRegistry 
} from './cache/index.js';
export type { 
  CacheEntry, 
  CacheStats, 
  CacheOptions 
} from './cache/types.js';

// Context Window Budget Optimizer
export { ContextBudgetOptimizer } from './context/budget-optimizer.js';
export type { ContextItem, ContextBudgetPlan, BudgetOptimizerConfig } from './context/types.js';
export { greedySelector } from './context/knapsack.js';

// Skills
export { SKILL_CATALOG } from './skills/engine.js';
export type { SkillDefinition, SkillEvidence, SkillGap } from './skills/engine.js';
export { AgentFingerprintExtractor, fingerprintExtractor } from './skills/fingerprint.js';
export type { FileEdit } from './skills/fingerprint.js';
export type { AgentFingerprint } from '../storage/kg/types.js';
export { persistAgentProfile, loadAgentProfile, extractFingerprintFromContent } from './skills/engine.js';

// Memory
export { searchTeamMemoriesSemantic } from './memory/semantic-memory.js';
export type { SemanticMemoryHit, SemanticMemoryOptions } from './memory/semantic-memory.js';

// Team Memory
export { threeWayMerge, diffHunks } from './team-memory/merge.js';
export type { DiffHunk, MergeConflict, MergeResult } from './team-memory/merge.js';

// Coordination
export { predictMergeRisk } from './coordination/risk.js';
export type { ConflictRiskInput, ConflictRisk } from './coordination/risk.js';

// Embeddings
export { VectorIndex, VecIndex } from './embeddings/vector-index.js';

// Dedup
export { CloneDetector } from './dedup/clone-detector.js';
export type { CloneDetectionOptions, CloneDetectionResult } from './dedup/clone-detector.js';

// Refactor
export { AutoFixEngine } from './refactor/auto-fix.js';
export type { AutoFixResult, FixerMeta } from './refactor/auto-fix.js';

// Predictive Impact Analysis
export { ImpactPredictor } from './predictive/impact-predictor.js';
export type { CodeChange, ImpactReport, ActualImpact, PredictorConfig } from './predictive/types.js';

// Watcher
export { ProjectWatcher } from './watcher.js';
export type { ProjectWatcherOptions, WatcherStats, WatcherBatchResult } from './watcher.js';

// Knowledge Graph Integrity Guard
export { IntegrityGuard } from './kg/integrity-guard.js';
export type { IntegrityViolation, RepairAction, IntegrityReport } from './kg/types.js';

// Intent-Driven Semantic Navigation (Hybrid RAG)
export { IntentEngine } from './search/intent-engine.js';
export type { IntentQuery, IntentType, HybridScore, SearchResult } from './search/types.js';

// Cross-Project Pattern Learning (F4)
export { CrossProjectPatternEngine } from './patterns/cross-project.js';
export type { LearnedPattern, PatternVariant, PatternGraph, AbstractionLevel } from './patterns/types.js';

// Real-Time Collaborative Agent Context (Live Intent Broadcast + Conflict Prediction)
export { IntentBroadcastService } from './collaboration/broadcast.js';
export type { IntentBroadcast, ConflictPrediction } from './collaboration/types.js';