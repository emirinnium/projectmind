import { KnowledgeGraph } from '@/storage/kg/graph.js';

export function trackAgentTouched(kg: KnowledgeGraph, filePath: string, agentName: string): void {
  kg.markAgentTouched(filePath, agentName);
}
