import type { KnowledgeGraph } from '@/storage/knowledge-graph.js';
import type { CoherenceEngine } from '@/core/coherence/engine.js';
import type { DebtTracker } from '@/core/debt/tracker.js';
import type { ScaleManager } from '@/core/scale/manager.js';
import type { LLMProvider } from '@/core/llm/index.js';

export interface McpDependencies {
  kg: KnowledgeGraph;
  coherence: CoherenceEngine;
  debt: DebtTracker;
  scale: ScaleManager;
  /** Absolute path of the active project root — CLI children are pinned to it
   *  and every user-supplied path is confined to it (K4/K5). */
  projectRoot: string;
  agentName?: string;
  /** Optional LLM provider for deep/heuristic suggestions (e.g. team-memory conflict resolution). */
  llmProvider?: LLMProvider | null;
}

/**
 * Wrapper to track agent file access through MCP tools
 */
export function trackAgentAccess(kg: KnowledgeGraph, agentName: string, filePath: string): void {
  kg.markAgentTouched(filePath, agentName);
}

/**
 * Validate required _meta fields in MCP requests.
 * @throws {Error} If _meta is missing or invalid.
 */
export function validateMeta(meta: unknown): asserts meta is {
  protocolVersion: string;
  clientInfo: {
    name: string;
    version?: string;
  };
  clientCapabilities?: Record<string, string | number | boolean | null>;
} {
  if (!meta || typeof meta !== 'object') {
    throw new Error('_meta is required and must be an object.');
  }
  const m = meta as Record<string, string | number | boolean | null>;
  if (typeof m.protocolVersion !== 'string') {
    throw new Error('_meta.protocolVersion is required and must be a string.');
  }
  if (!m.clientInfo || typeof m.clientInfo !== 'object') {
    throw new Error('_meta.clientInfo is required and must be an object.');
  }
  const clientInfo = m.clientInfo as Record<string, string | number | boolean | null>;
  if (typeof clientInfo.name !== 'string') {
    throw new Error('_meta.clientInfo.name is required and must be a string.');
  }
}

/**
 * Error thrown when a request-level `_meta` block fails envelope validation.
 */
export class MetaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetaValidationError';
  }
}

/**
 * Minimal structural shape of an MCP JSON-RPC request carrying `_meta`.
 * We deliberately keep this loose — the request boundary only needs to
 * locate `params._meta` (or the legacy `params.meta`) to validate it.
 */
interface JsonRpcRequestLike {
  params?: { _meta?: unknown; meta?: unknown };
}

/**
 * Validate the optional request-level `_meta` envelope at the transport edge.
 *
 * Per the MCP specification `_meta` is OPTIONAL. When it is absent this is a
 * no-op. When present we only treat it as the client-envelope `_meta` (and
 * enforce the documented `protocolVersion` + `clientInfo` shape) if it
 * advertises a `protocolVersion`. This deliberately leaves generic SDK
 * `_meta` (e.g. `progressToken`) untouched so spec-compliant clients are
 * never rejected.
 *
 * @throws {MetaValidationError} When an envelope `_meta` is present but malformed.
 */
export function validateRequestMeta(request: unknown): asserts request is JsonRpcRequestLike {
  if (!request || typeof request !== 'object') return;
  const maybeReq = request as Record<string, unknown>;
  const params = maybeReq.params;
  if (params === undefined || params === null || typeof params !== 'object') return;
  const paramsObj = params as Record<string, unknown>;
  const meta = paramsObj._meta ?? paramsObj.meta;
  if (meta === undefined || meta === null || typeof meta !== 'object') return;
  const metaObj = meta as Record<string, unknown>;
  // Only enforce the envelope shape when the client actually sends one.
  if (typeof metaObj.protocolVersion !== 'string') return;
  try {
    validateMeta(meta);
  } catch (e) {
    throw new MetaValidationError(e instanceof Error ? e.message : String(e));
  }
}