import { KnowledgeGraph } from '@/index.js';

export function trackAgentTouched(kg: KnowledgeGraph, filePath: string, agentName: string): void {
  kg.markAgentTouched(filePath, agentName);
}
