/**
 * Tool-list cache hints — Faz 1 (MCP protocol compliance).
 *
 * The MCP tool-list contract lets clients cache `tools/list` results. The SDK's
 * `registerTool` config does not expose native `ttlMs` / `cacheScope` fields,
 * so — following the spec's `_meta` extension channel — we attach those hints
 * inside each tool's `_meta` block. The canonical integration point is
 * `src/mcp/tools/registry/index.ts`, which should spread `toolCacheHintMeta(name)`
 * into every tool's config. As a reference integration, `src/mcp/resources.ts`
 * applies these hints to the `resource_subscribe` / `resource_unsubscribe` tools.
 */

export type ToolCacheScope = 'global' | 'session';

export interface ToolCacheHint {
  /** How long (ms) a client may safely cache this tool's definition. */
  ttlMs: number;
  /** 'global' = process-wide cache; 'session' = per-client (agent) cache. */
  cacheScope: ToolCacheScope;
}

/** Default hint applied to any tool not explicitly listed in {@link TOOL_CACHE_HINTS}. */
export const DEFAULT_TOOL_CACHE_HINT: ToolCacheHint = {
  ttlMs: 300_000,
  cacheScope: 'global',
};

/**
 * Per-tool cache hints. Stable tool definitions get a long TTL; tools that
 * reflect live project state get a short TTL so clients refresh promptly.
 * The registry should populate this map for every registered tool.
 */
export const TOOL_CACHE_HINTS: Record<string, ToolCacheHint> = {
  get_context: { ttlMs: 30_000, cacheScope: 'session' },
  get_file_status: { ttlMs: 15_000, cacheScope: 'session' },
  list_changed: { ttlMs: 60_000, cacheScope: 'global' },
};

export function getToolCacheHint(name: string): ToolCacheHint {
  return TOOL_CACHE_HINTS[name] ?? DEFAULT_TOOL_CACHE_HINT;
}

/**
 * Build the `_meta` block carrying cache hints for tool `name`. Spread it into
 * a tool's `registerTool` config, e.g.:
 *
 *   server.registerTool(name, { ...toolCacheHintMeta(name), title, description, inputSchema }, cb);
 */
export function toolCacheHintMeta(name: string): { _meta: Record<string, unknown> } {
  const hint = getToolCacheHint(name);
  return { _meta: { ttlMs: hint.ttlMs, cacheScope: hint.cacheScope } };
}
