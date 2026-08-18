import type { KnowledgeGraph } from '../../storage/knowledge-graph.js';
import type { CoherenceEngine } from '../../core/coherence-engine.js';
import type { DebtTracker } from '../../core/debt-tracker.js';
import type { ScaleManager } from '../../core/scale-manager.js';

export interface McpDependencies {
  kg: KnowledgeGraph;
  coherence: CoherenceEngine;
  debt: DebtTracker;
  scale: ScaleManager;
  agentName?: string;
}

/**
 * Wrapper to track agent file access through MCP tools
 */
export function trackAgentAccess(kg: KnowledgeGraph, agentName: string, filePath: string): void {
  kg.markAgentTouched(filePath, agentName);
}