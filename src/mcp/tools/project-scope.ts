import { AsyncLocalStorage } from 'node:async_hooks';
import { CoherenceEngine } from '@/core/coherence/engine.js';
import { DebtTracker } from '@/core/debt/tracker.js';
import { ScaleManager } from '@/core/scale/manager.js';
import type { McpDependencies } from './types.js';

interface ProjectScopeState {
  deps: McpDependencies;
}

export interface McpProjectScopeRuntime {
  deps: McpDependencies;
  run<T>(projectId: unknown, operation: () => Promise<T>): Promise<T>;
}

const projectScope = new AsyncLocalStorage<ProjectScopeState>();

function parseProjectId(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error('projectId must be a positive integer when provided.');
  }
  return value as number;
}

function scopedDependencies(base: McpDependencies, projectId: number): McpDependencies {
  if (!base.db) throw new Error('Explicit project selection requires an initialized database.');
  const project = base.kg.getProject(projectId);
  if (!project) throw new Error(`Project ${projectId} not found.`);
  const kg = base.kg.createProjectScope(projectId);
  const coherence = new CoherenceEngine(base.db);
  if (base.llmProvider) coherence.setLLMProvider(base.llmProvider);
  const debt = new DebtTracker(base.db, kg, coherence);
  const scale = new ScaleManager(base.db, kg);
  return {
    ...base,
    kg,
    coherence,
    debt,
    scale,
    projectRoot: project.rootPath,
  };
}

/**
 * Build the dependency view used while registering tools. The proxy keeps
 * existing tool closures source-compatible while AsyncLocalStorage selects a
 * request-local project for concurrent MCP calls.
 */
export function createMcpProjectScopeRuntime(base: McpDependencies): McpProjectScopeRuntime {
  const proxy = new Proxy(base, {
    get(target, property, receiver) {
      const active = projectScope.getStore()?.deps ?? target;
      return Reflect.get(active, property, receiver);
    },
  }) as McpDependencies;

  return {
    deps: proxy,
    async run<T>(projectIdValue: unknown, operation: () => Promise<T>): Promise<T> {
      const projectId = parseProjectId(projectIdValue);
      if (projectId === undefined) return operation();
      return projectScope.run({ deps: scopedDependencies(base, projectId) }, operation);
    },
  };
}
