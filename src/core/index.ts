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