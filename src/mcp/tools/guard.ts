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
  'kg_query',
  'list_projects',
  'search_team_memories',
  'resolve_import',
  'resolve_path',
  'scale_report',
  'suggest_refactor',
  'trace_imports',
]);

/**
 * Read-only tools that may reach the OUTSIDE world (cloud LLM, external
 * embedding providers). Per MCP spec openWorldHint defaults to true, so we
 * simply skip setting it false for these instead of special-casing later.
 */
const READ_ONLY_OPEN_WORLD_EXCEPTIONS = new Set(['check_coherence', 'generate_embedding']);

/** Parity roots that may reach the outside world (deps-fresh --audit → npm registry). */
const PARITY_OPEN_WORLD_EXCEPTIONS = new Set(['deps-fresh']);

/** 'analyze_impact' -> 'Analyze Impact' (annotation title fallback). */
function humanizeToolName(name: string): string {
  return name
    .split(/[_-]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Wrap server.registerTool so every DEDICATED registration made after this
 * call receives correct annotations without touching each tool file.
 *
 * Read-only tools get the full hint set:
 * - readOnlyHint + idempotentHint  → clients can skip approval dialogs
 * - destructiveHint: false         → explicitly non-destructive (spec default
 *                                    is true when readOnlyHint is false!)
 * - openWorldHint: false           → local-only analysis (except LLM/network
 *                                    tools listed in READ_ONLY_OPEN_WORLD_EXCEPTIONS)
 * - title                          → human-readable label when the tool file
 *                                    did not define one
 */
export function annotateToolRegistration(server: McpServer): void {
  type JsonLike = string | number | boolean | null | JsonLike[] | { [key: string]: JsonLike };
  const target = server as unknown as {
    registerTool: (name: string, cfg: Record<string, JsonLike>, ...rest: JsonLike[]) => unknown;
  };
  const original = target.registerTool.bind(server);
  target.registerTool = (name, cfg, ...rest) => {
    if (DEDICATED_READ_ONLY.has(name)) {
      const openWorld = !READ_ONLY_OPEN_WORLD_EXCEPTIONS.has(name);
      const annotations = (cfg as Record<string, JsonLike>).annotations as Record<string, JsonLike> | undefined;
      (cfg as Record<string, JsonLike>).annotations = {
        ...(annotations?.title ? {} : { title: humanizeToolName(name) }),
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        ...(openWorld ? { openWorldHint: false } : {}),
        ...(annotations ?? {}),
      };
    }
    const result = original(name, cfg, ...rest);
    return result;
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

/** Full annotation set for a parity tool identified by its CLI path, if read-only. */
export function parityAnnotations(path: string[]): {
  readOnlyHint: boolean;
  idempotentHint: boolean;
  destructiveHint: boolean;
  openWorldHint?: boolean;
} | undefined {
  if (path.length > 0 && PARITY_READ_ONLY_ROOTS.has(path[0])) {
    const openWorld = !PARITY_OPEN_WORLD_EXCEPTIONS.has(path[0]);
    return {
      readOnlyHint: true,
      idempotentHint: true,
      destructiveHint: false,
      ...(openWorld ? { openWorldHint: false } : {}),
    };
  }
  return undefined;
}

/**
 * Tool surface profile. `PROJECTMIND_TOOLS=all` registers the full surface
 * including generated pm_* parity tools (~130 total).
 * `PROJECTMIND_TOOLS=core` (DEFAULT) skips parity tools (~45 tools) so clients
 * with a small active-tool budget (e.g. Cursor's limit) can use ProjectMind.
 * The run_cli bridge always remains available as escape hatch.
 * Set `PROJECTMIND_TOOLS=all` to enable the full parity surface.
 */
export function shouldRegisterParityTools(): boolean {
  const profile = (process.env.PROJECTMIND_TOOLS || 'core').trim().toLowerCase();
  return profile === 'all';
}
