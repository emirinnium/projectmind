import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/** Root commands that must never be launched through the MCP surface. */
export const BLOCKED_ROOT_COMMANDS = new Set(['mcp', 'init']);

/**
 * Destructive subcommands blocked through the agent-facing MCP surface
 * (run_cli bridge AND generated pm_* parity tools). The terminal CLI stays
 * unrestricted — this guard only protects against a confused model wiping
 * analysis data through MCP.
 */
const DESTRUCTIVE_SUBCOMMANDS: Record<string, Set<string>> = {
  project: new Set(['delete']),
  doctor: new Set(['rebuild-index']),
  debt: new Set(['clear', 'clear-patterns']),
  'data-flow': new Set(['clear']),
  trace: new Set(['clear']),
};

/**
 * True when the given argv vector targets a blocked root or a destructive
 * subcommand. argv[0] is the root command, argv[1] the subcommand (if any).
 */
export function isBlockedCliInvocation(argv: string[]): boolean {
  if (argv.length === 0) return true;
  if (BLOCKED_ROOT_COMMANDS.has(argv[0])) return true;
  const subs = DESTRUCTIVE_SUBCOMMANDS[argv[0]];
  return !!subs && argv.length > 1 && subs.has(argv[1]);
}

/**
 * Dedicated MCP tools that are pure readers / pure computations. These get
 * readOnlyHint (+idempotentHint) so MCP clients can skip approval dialogs.
 * Everything NOT listed stays unannotated = conservative default.
 */
const DEDICATED_READ_ONLY = new Set([
  'analyze_impact',
  'analyze_taint',
  'check_architecture',
  'check_coherence',
  'debt_report',
  'find_circular_deps',
  'find_file_by_import',
  'generate_embedding',
  'genome_score',
  'get_agent_sessions',
  'get_context',
  'get_data_flows',
  'get_dependency_graph',
  'get_dependents',
  'get_embedding_provider',
  'get_file_status',
  'get_memory',
  'get_resource_flows',
  'get_team_memories',
  'list_projects',
  'resolve_import',
  'resolve_path',
  'scale_report',
  'suggest_refactor',
  'trace_imports',
]);

/**
 * Wrap server.registerTool so every DEDICATED registration made after this
 * call receives correct annotations without touching each tool file.
 */
export function annotateToolRegistration(server: McpServer): void {
  const target = server as unknown as {
    registerTool: (name: string, cfg: Record<string, unknown>, ...rest: unknown[]) => unknown;
  };
  const original = target.registerTool.bind(server);
  target.registerTool = (name, cfg, ...rest) => {
    if (DEDICATED_READ_ONLY.has(name)) {
      cfg.annotations = { readOnlyHint: true, idempotentHint: true, ...(cfg.annotations ?? {}) };
    }
    return original(name, cfg, ...rest);
  };
}

/**
 * CLI roots whose parity tools are pure reports/analyses of the local
 * project (optional `-o <file>` export does not change their read nature).
 * Roots with ANY writing subcommand (taint record, embed init,
 * structural-search replace, layers --auto-fix, adr new, contract-test
 * generate, ...) are deliberately excluded and stay unannotated.
 */
const PARITY_READ_ONLY_ROOTS = new Set([
  'report', 'genome', 'scale', 'health', 'heatmap', 'ownership',
  'search', 'impact', 'context', 'audit', 'license', 'graph',
  'churn', 'api-surface', 'dedup', 'debug', 'coupling',
  'refactor-roi', 'context-budget', 'pr-preview', 'doctor',
  'debt-prioritize', 'flags', 'skill-recommend', 'test-quality',
  'sbom', 'deps-fresh', 'secrets-life',
]);

/** Annotations for a parity tool identified by its CLI path, if read-only. */
export function parityAnnotations(path: string[]): { readOnlyHint: boolean; idempotentHint: boolean } | undefined {
  if (path.length > 0 && PARITY_READ_ONLY_ROOTS.has(path[0])) {
    return { readOnlyHint: true, idempotentHint: true };
  }
  return undefined;
}

/**
 * Tool surface profile. `PROJECTMIND_TOOLS=all` (default) registers the full
 * surface including generated pm_* parity tools (~130 total).
 * `PROJECTMIND_TOOLS=core` skips parity tools (~45 tools) so clients with a
 * small active-tool budget (e.g. Cursor's limit) can use ProjectMind.
 * The run_cli bridge always remains available as escape hatch.
 */
export function shouldRegisterParityTools(): boolean {
  const profile = (process.env.PROJECTMIND_TOOLS || 'all').trim().toLowerCase();
  return profile !== 'core';
}
