import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toolCacheHintMeta } from './list.js';
export { parityAnnotations } from './parity-annotations.js';

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
  doctor: new Set(['rebuild-index', 'clean-debt']),
  debt: new Set(['clear', 'clear-patterns']),
  'data-flow': new Set(['clear']),
  trace: new Set(['clear']),
  layers: new Set(['--auto-fix']), // writes generated fixes back to entry files
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
 * Complete MCP behavior annotation used by every registered core tool.
 *
 * These values describe the actual operation, not merely whether a tool
 * returns a report. For example, genome_score persists a derived snapshot,
 * scan_project prunes stale graph rows, and run_cli can reach the network and
 * execute state-changing commands through its allowlisted bridge.
 */
export interface CompleteToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

const READ_ONLY_LOCAL: CompleteToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const WRITE_DERIVED: CompleteToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

/** The 66 dedicated tools plus the two resource-subscription tools. */
export const MCP_CORE_TOOL_NAMES = [
  'check_coherence',
  'get_context',
  'store_memory',
  'get_memory',
  'debt_report',
  'scale_report',
  'genome_score',
  'scan_project',
  'start_session',
  'end_session',
  'get_agent_sessions',
  'trace_imports',
  'find_circular_deps',
  'resolve_import',
  'get_dependents',
  'get_dependency_graph',
  'kg_query',
  'kg_stats',
  'export_architecture_diagram',
  'resolve_path',
  'find_file_by_import',
  'check_architecture',
  'analyze_impact',
  'suggest_refactor',
  'check_contracts',
  'auto_fix',
  'register_file_watch',
  'get_file_status',
  'sync_context',
  'unregister_file_watch',
  'agent_locks',
  'predict_merge_risk',
  'predict_impact_risk',
  'ingest_trace',
  'structural_search',
  'list_projects',
  'create_project',
  'switch_project',
  'record_data_flow',
  'get_data_flows',
  'get_resource_flows',
  'clear_data_flows',
  'init_embedding_provider',
  'generate_embedding',
  'get_embedding_provider',
  'analyze_taint',
  'record_taint',
  'store_team_memory',
  'get_team_memories',
  'search_team_memories',
  'search_intent',
  'predict_impact',
  'plan_context_budget',
  'check_kg_integrity',
  'broadcast_intent',
  'check_intent_conflicts',
  'find_patterns',
  'semantic_search',
  'find_symbol_references',
  'find_symbol_definition',
  'suggest_next_files',
  'recommend_skills',
  'run_cli',
  'scan_cves',
  'prove_claim',
  'verify_freshness',
  'resource_subscribe',
  'resource_unsubscribe',
] as const;

const OPEN_WORLD_READ_ONLY: CompleteToolAnnotations = {
  ...READ_ONLY_LOCAL,
  openWorldHint: true,
};

const WRITE_EXTERNAL: CompleteToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

const DESTRUCTIVE_WRITE: CompleteToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

const DESTRUCTIVE_IDEMPOTENT: CompleteToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

const REVERSIBLE_IDEMPOTENT: CompleteToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/**
 * Per-tool classification. Keep this map exhaustive: the registration guard
 * throws if a new dedicated tool is added without an explicit classification.
 */
export const TOOL_ANNOTATIONS: Readonly<Record<string, CompleteToolAnnotations>> = {
  check_coherence: OPEN_WORLD_READ_ONLY,
  get_context: READ_ONLY_LOCAL,
  store_memory: WRITE_DERIVED,
  get_memory: READ_ONLY_LOCAL,
  debt_report: WRITE_DERIVED,
  scale_report: READ_ONLY_LOCAL,
  genome_score: WRITE_DERIVED,
  scan_project: { ...DESTRUCTIVE_WRITE, idempotentHint: false },
  start_session: WRITE_DERIVED,
  end_session: WRITE_DERIVED,
  get_agent_sessions: READ_ONLY_LOCAL,
  trace_imports: READ_ONLY_LOCAL,
  find_circular_deps: { ...WRITE_DERIVED, idempotentHint: true },
  resolve_import: READ_ONLY_LOCAL,
  get_dependents: READ_ONLY_LOCAL,
  get_dependency_graph: READ_ONLY_LOCAL,
  kg_query: READ_ONLY_LOCAL,
  kg_stats: READ_ONLY_LOCAL,
  export_architecture_diagram: READ_ONLY_LOCAL,
  resolve_path: READ_ONLY_LOCAL,
  find_file_by_import: READ_ONLY_LOCAL,
  check_architecture: READ_ONLY_LOCAL,
  analyze_impact: READ_ONLY_LOCAL,
  suggest_refactor: READ_ONLY_LOCAL,
  check_contracts: READ_ONLY_LOCAL,
  auto_fix: DESTRUCTIVE_WRITE,
  register_file_watch: WRITE_DERIVED,
  get_file_status: READ_ONLY_LOCAL,
  sync_context: WRITE_DERIVED,
  unregister_file_watch: REVERSIBLE_IDEMPOTENT,
  agent_locks: WRITE_DERIVED,
  predict_merge_risk: READ_ONLY_LOCAL,
  predict_impact_risk: READ_ONLY_LOCAL,
  ingest_trace: WRITE_DERIVED,
  structural_search: DESTRUCTIVE_WRITE,
  list_projects: READ_ONLY_LOCAL,
  create_project: WRITE_DERIVED,
  switch_project: { ...WRITE_DERIVED, idempotentHint: true },
  record_data_flow: WRITE_DERIVED,
  get_data_flows: READ_ONLY_LOCAL,
  get_resource_flows: READ_ONLY_LOCAL,
  clear_data_flows: DESTRUCTIVE_IDEMPOTENT,
  init_embedding_provider: WRITE_EXTERNAL,
  generate_embedding: OPEN_WORLD_READ_ONLY,
  get_embedding_provider: READ_ONLY_LOCAL,
  analyze_taint: READ_ONLY_LOCAL,
  record_taint: WRITE_DERIVED,
  store_team_memory: WRITE_EXTERNAL,
  get_team_memories: READ_ONLY_LOCAL,
  search_team_memories: READ_ONLY_LOCAL,
  search_intent: READ_ONLY_LOCAL,
  predict_impact: READ_ONLY_LOCAL,
  plan_context_budget: READ_ONLY_LOCAL,
  check_kg_integrity: DESTRUCTIVE_WRITE,
  broadcast_intent: WRITE_DERIVED,
  check_intent_conflicts: READ_ONLY_LOCAL,
  find_patterns: READ_ONLY_LOCAL,
  semantic_search: OPEN_WORLD_READ_ONLY,
  find_symbol_references: READ_ONLY_LOCAL,
  find_symbol_definition: READ_ONLY_LOCAL,
  suggest_next_files: READ_ONLY_LOCAL,
  recommend_skills: READ_ONLY_LOCAL,
  run_cli: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  scan_cves: OPEN_WORLD_READ_ONLY,
  prove_claim: READ_ONLY_LOCAL,
  verify_freshness: READ_ONLY_LOCAL,
  resource_subscribe: REVERSIBLE_IDEMPOTENT,
  resource_unsubscribe: REVERSIBLE_IDEMPOTENT,
};

function hasCompleteAnnotations(value: unknown): value is CompleteToolAnnotations {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.readOnlyHint === 'boolean' &&
    typeof record.destructiveHint === 'boolean' &&
    typeof record.idempotentHint === 'boolean' &&
    typeof record.openWorldHint === 'boolean'
  );
}

/** 'analyze_impact' -> 'Analyze Impact' (annotation title fallback). */
function humanizeToolName(name: string): string {
  return name
    .split(/[_-]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Wrap server.registerTool so every registration made after this call
 * receives a complete behavior classification without touching each tool
 * file. CLI parity registrations provide their own complete classification.
 *
 * Every tool config also gets the `_meta` cache hint (ttlMs/cacheScope) via
 * {@link toolCacheHintMeta} — the documented cache-hint feature
 * (src/mcp/tools/list.ts) now applies to tools, not just resources. `_meta`
 * is the MCP spec's standard extension channel, so this is additive and
 * non-breaking for clients and tests.
 *
 * Every core tool gets all four behavior hints explicitly. This matters for
 * clients that do not apply the MCP specification defaults consistently.
 */
export function annotateToolRegistration(server: McpServer): void {
  type JsonLike = string | number | boolean | null | JsonLike[] | { [key: string]: JsonLike };
  const target = server as unknown as {
    registerTool: (name: string, cfg: Record<string, JsonLike>, ...rest: JsonLike[]) => unknown;
  };
  const original = target.registerTool.bind(server);
  target.registerTool = (name, cfg, ...rest) => {
    // Cache hints: spread toolCacheHintMeta(name) into every tool config
    // (matches the resources.ts integration pattern). Stable tool definitions
    // get a long TTL; tools reflecting live project state get a short TTL.
    cfg._meta = toolCacheHintMeta(name)._meta as Record<string, JsonLike>;
    const existing = (cfg as Record<string, JsonLike>).annotations as
      Record<string, JsonLike> | undefined;
    const explicit = TOOL_ANNOTATIONS[name];
    const supplied = hasCompleteAnnotations(existing) ? existing : undefined;
    const annotations = explicit ?? supplied;
    if (!annotations) {
      throw new Error(`Missing complete MCP behavior annotations for tool: ${name}`);
    }
    const title =
      typeof existing?.title === 'string'
        ? existing.title
        : typeof cfg.title === 'string'
          ? cfg.title
          : humanizeToolName(name);
    (cfg as Record<string, JsonLike>).annotations = {
      title,
      ...existing,
      ...annotations,
    };
    const result = original(name, cfg, ...rest);
    return result;
  };
}

/**
 * Tool surface profile. `PROJECTMIND_TOOLS=all` registers the full surface
 * including generated pm_* parity tools (~130 total).
 * `PROJECTMIND_TOOLS=core` (DEFAULT) skips parity tools (~66 dedicated tools) so clients
 * with a small active-tool budget (e.g. Cursor's limit) can use ProjectMind.
 * The run_cli bridge always remains available as escape hatch.
 * Set `PROJECTMIND_TOOLS=all` to enable the full parity surface.
 */
export function shouldRegisterParityTools(): boolean {
  const profile = (process.env.PROJECTMIND_TOOLS || 'core').trim().toLowerCase();
  return profile === 'all';
}
