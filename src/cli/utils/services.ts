import { ScaleManager } from '@/core/scale/manager.js';
import { DebtTracker } from '@/core/debt/tracker.js';
import { CoherenceEngine } from '@/core/coherence/engine.js';
import { createLLMProvider } from '@/core/llm/factory.js';
import { CLIContext, createContext, closeContext } from './context.js';

export interface ServiceMap {
  scale?: ScaleManager;
  debt?: DebtTracker;
  coherence?: CoherenceEngine;
}

export async function withContext<T>(
  fn: (ctx: CLIContext) => Promise<T>,
  overrideRoot?: string
): Promise<T> {
  const ctx = await createContext(overrideRoot);
  try {
    return await fn(ctx);
  } finally {
    closeContext(ctx);
  }
}

export async function withService<T>(
  services: ('scale' | 'debt' | 'coherence')[],
  fn: (ctx: CLIContext, services: ServiceMap) => Promise<T>,
  overrideRoot?: string
): Promise<T> {
  return withContext(async (ctx) => {
    const serviceMap: ServiceMap = {};
    
    if (services.includes('scale')) {
      serviceMap.scale = new ScaleManager(ctx.db, ctx.kg);
    }
    
    if (services.includes('debt')) {
      serviceMap.debt = new DebtTracker(ctx.db, ctx.kg);
    }
    
    if (services.includes('coherence')) {
      const coherence = new CoherenceEngine(ctx.db);
      const llmConfig = {
        provider: ctx.config.llm.provider,
        model: ctx.config.llm.model,
        apiKey: ctx.config.llm.apiKey,
        deepModel: ctx.config.llm.deepModel,
      };
      const llmProvider = createLLMProvider(llmConfig);
      if (llmProvider) {
        coherence.setLLMProvider(llmProvider);
      }
      serviceMap.coherence = coherence;
    }
    
    return await fn(ctx, serviceMap);
  }, overrideRoot);
}

export async function withScale<T>(
  fn: (ctx: CLIContext, scale: ScaleManager) => Promise<T>
): Promise<T> {
  return withService(['scale'], async (ctx, services) => {
    if (!services.scale) throw new Error('ScaleManager not available');
    return fn(ctx, services.scale);
  });
}

export async function withDebt<T>(
  fn: (ctx: CLIContext, debt: DebtTracker) => Promise<T>
): Promise<T> {
  return withService(['debt'], async (ctx, services) => {
    if (!services.debt) throw new Error('DebtTracker not available');
    return fn(ctx, services.debt);
  });
}

export async function withCoherence<T>(
  fn: (ctx: CLIContext, coherence: CoherenceEngine) => Promise<T>
): Promise<T> {
  return withService(['coherence'], async (ctx, services) => {
    if (!services.coherence) throw new Error('CoherenceEngine not available');
    return fn(ctx, services.coherence);
  });
}

export async function withServices<T>(
  services: ('scale' | 'debt' | 'coherence')[],
  fn: (ctx: CLIContext, services: ServiceMap) => Promise<T>
): Promise<T> {
  return withService(services, fn);
}
