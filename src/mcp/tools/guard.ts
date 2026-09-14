import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { toolCacheHintMeta } from './list.js';
import { measureInvocation } from '@/core/telemetry/invocation.js';
import {
  actionableMcpError,
  toActionableError,
  type ActionableErrorShape,
} from '@/utils/actionable-error.js';
import { asUntrustedContent } from '@/mcp/security/untrusted-content.js';
import type { McpProjectScopeRuntime } from './project-scope.js';
export { parityAnnotations } from './parity-annotations.js';

/** Root commands that must never be launched through the MCP surface. */
export const BLOCKED_ROOT_COMMANDS = new Set(['mcp', 'init', 'init-mcp', 'mcp-init']);

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
 * subcommand.
 *
 * The MCP bridge accepts an agent-supplied argument vector, so options may be
 * interleaved with values. Never assume a destructive token is argv[1].
 */
export function isBlockedCliInvocation(argv: string[]): boolean {
  if (argv.length === 0) return true;
  if (BLOCKED_ROOT_COMMANDS.has(argv[0])) return true;
  const subs = DESTRUCTIVE_SUBCOMMANDS[argv[0]];
  if (!subs) return false;

  for (const token of argv.slice(1)) {
    if (subs.has(token)) return true;
    // Commander also accepts boolean options in --flag=true form.
    if (argv[0] === 'layers' && token.startsWith('--auto-fix=')) return true;
  }
  return false;
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

export interface McpToolBudget {
  latencyClass: 'fast' | 'standard' | 'heavy' | 'external';
  maxOutputBytes: number;
  maxOutputTokens: number;
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

/** Dedicated tools plus the two resource-subscription tools in the default registry. */
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
  'record_autofix_feedback',
  'recommend_autofix',
  'set_autofix_feedback_opt_out',
  'reset_autofix_feedback',
  'register_file_watch',
  'get_file_status',
  'sync_context',
  'unregister_file_watch',
  'agent_locks',
  'predict_merge_risk',
  'arbitrate_agents',
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
  'exploit_path',
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
  'record_search_feedback',
  'record_session_event',
  'get_session_insights',
  'predict_bug_surface',
  'ask_codebase',
  'find_symbol_references',
  'find_symbol_definition',
  'suggest_next_files',
  'recommend_skills',
  'run_cli',
  'scan_cves',
  'prove_claim',
  'verify_freshness',
  'get_source_range',
  'get_source_symbol_range',
  'get_invocation_metrics',
  'evidence_ledger',
  'record_evidence',
  'agent_replay',
  'record_replay_event',
  'review_project',
  'get_canonical_example',
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
  // get_context tracks access and records payload-free evidence/replay
  // metadata when a database is available; it is therefore derived-write.
  get_context: WRITE_DERIVED,
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
  record_autofix_feedback: WRITE_DERIVED,
  recommend_autofix: READ_ONLY_LOCAL,
  set_autofix_feedback_opt_out: WRITE_DERIVED,
  reset_autofix_feedback: DESTRUCTIVE_WRITE,
  register_file_watch: WRITE_DERIVED,
  get_file_status: READ_ONLY_LOCAL,
  sync_context: WRITE_DERIVED,
  unregister_file_watch: REVERSIBLE_IDEMPOTENT,
  agent_locks: WRITE_DERIVED,
  predict_merge_risk: READ_ONLY_LOCAL,
  // Arbitration records only payload-free hashes/summary metadata by default;
  // it never mutates source files or git state.
  arbitrate_agents: WRITE_DERIVED,
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
  exploit_path: READ_ONLY_LOCAL,
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
  record_search_feedback: WRITE_DERIVED,
  record_session_event: WRITE_DERIVED,
  get_session_insights: READ_ONLY_LOCAL,
  predict_bug_surface: READ_ONLY_LOCAL,
  ask_codebase: OPEN_WORLD_READ_ONLY,
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
  get_source_range: READ_ONLY_LOCAL,
  get_source_symbol_range: READ_ONLY_LOCAL,
  get_invocation_metrics: READ_ONLY_LOCAL,
  evidence_ledger: READ_ONLY_LOCAL,
  record_evidence: WRITE_DERIVED,
  agent_replay: READ_ONLY_LOCAL,
  record_replay_event: WRITE_DERIVED,
  // Review persists payload-free decision metadata in the evidence ledger
  // and replay chain; it never writes source files.
  review_project: WRITE_DERIVED,
  get_canonical_example: READ_ONLY_LOCAL,
  resource_subscribe: REVERSIBLE_IDEMPOTENT,
  resource_unsubscribe: REVERSIBLE_IDEMPOTENT,
};

/** Project-management tools intentionally operate on the global project list. */
const GLOBAL_PROJECT_TOOLS = new Set(['list_projects', 'create_project', 'switch_project']);

/** Return a bounded payload/latency budget for every dedicated or parity tool. */
export function getMcpToolBudget(name: string): McpToolBudget {
  const normalized = name.toLowerCase();
  const external =
    normalized.includes('audit') ||
    normalized.includes('embed') ||
    normalized.includes('deps') ||
    normalized.includes('cve') ||
    normalized === 'run_cli';
  const heavy =
    normalized.includes('scan') ||
    normalized.includes('context') ||
    normalized.includes('review') ||
    normalized.includes('graph') ||
    normalized === 'scale_report' ||
    normalized === 'kg_stats' ||
    normalized.includes('diagram') ||
    normalized.includes('search') ||
    normalized.includes('impact') ||
    normalized.includes('symbol_references') ||
    normalized.includes('canonical_example');
  const latencyClass = external
    ? 'external'
    : heavy
      ? 'heavy'
      : normalized.startsWith('pm_')
        ? 'standard'
        : 'fast';
  const maxOutputBytes =
    latencyClass === 'fast' ? 64_000 : latencyClass === 'standard' ? 256_000 : 1_000_000;
  return {
    latencyClass,
    maxOutputBytes,
    maxOutputTokens: Math.ceil(maxOutputBytes / 4),
  };
}

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
 * Normalize legacy handlers that return `{ success: false, error }` inside
 * an MCP text payload. This is additive: the original error remains available
 * for existing clients, while new clients receive structured next actions.
 */
function addActionableFailureDetails(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.content)) return value;
  let changed = false;
  let topLevelError: ActionableErrorShape | undefined;
  const content = record.content.map((block) => {
    if (!block || typeof block !== 'object') return block;
    const contentBlock = block as Record<string, unknown>;
    if (contentBlock.type !== 'text' || typeof contentBlock.text !== 'string') return block;
    let payload: Record<string, unknown> | undefined;
    try {
      const parsed: unknown = JSON.parse(contentBlock.text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return block;
      payload = parsed as Record<string, unknown>;
    } catch (error) {
      void error;
    }

    // Most current handlers already use the structured error shape. Keep the
    // original fields for compatibility, but make the actionable contract
    // available for every legacy `{ success: false, error }` payload too.
    if (
      payload &&
      typeof payload.error === 'string' &&
      (payload.success === undefined || payload.success === false) &&
      payload.errorDetails === undefined
    ) {
      const problem = toActionableError(new Error(payload.error));
      topLevelError ??= problem;
      changed = true;
      return {
        ...contentBlock,
        text: JSON.stringify({
          ...payload,
          errorDetails: problem,
          nextAction: payload.nextAction ?? problem.nextActions[0],
        }),
      };
    }

    // A few older handlers return a plain text MCP error. Do not rewrite that
    // text (clients may display it verbatim); attach the structured diagnostic
    // at the result level below so the same remediation contract is available.
    if (record.isError === true && !payload && contentBlock.text.trim()) {
      topLevelError ??= toActionableError(new Error(contentBlock.text));
    }
    if (payload && record.isError === true && typeof payload.error === 'string') {
      topLevelError ??= toActionableError(new Error(payload.error));
    }
    if (!payload) {
      return block;
    }
    const enriched = addUntrustedSnippetDetails(payload);
    if (enriched !== payload) {
      changed = true;
      return { ...contentBlock, text: JSON.stringify(enriched) };
    }
    return block;
  });
  if (!changed && !topLevelError) return value;
  return {
    ...record,
    ...(topLevelError
      ? {
          isError: true,
          errorDetails: topLevelError,
          nextAction: topLevelError.nextActions[0],
        }
      : {}),
    content,
  };
}

/**
 * Additive compatibility metadata for legacy source snippets. Newer tools
 * emit this at their source, while the registry boundary covers older tools
 * without changing their existing `snippet`/`file` fields. Only a safe
 * repository-relative path is accepted as provenance; an absolute or escaping
 * path is deliberately left unannotated rather than echoed into an envelope.
 */
function addUntrustedSnippetDetails(value: unknown, inheritedPath?: string): unknown {
  if (Array.isArray(value)) {
    let changed = false;
    const result = value.map((item) => {
      const enriched = addUntrustedSnippetDetails(item, inheritedPath);
      changed ||= enriched !== item;
      return enriched;
    });
    return changed ? result : value;
  }
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const candidatePath = [record.relativePath, record.filePath, record.file, record.path].find(
    (item): item is string => typeof item === 'string',
  );
  const sourcePath = safeRelativeSourcePath(candidatePath ?? inheritedPath);
  let changed = false;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    const enriched = addUntrustedSnippetDetails(item, sourcePath);
    changed ||= enriched !== item;
    result[key] = enriched;
  }
  if (
    typeof record.snippet === 'string' &&
    record.snippet.length > 0 &&
    record.untrustedContent === undefined &&
    sourcePath
  ) {
    result.untrustedContent = asUntrustedContent(record.snippet, 'source', {
      relativePath: sourcePath,
    });
    changed = true;
  }
  return changed ? result : value;
}

function safeRelativeSourcePath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '');
  if (
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split('/').some((segment) => segment === '..')
  )
    return undefined;
  return normalized;
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
export function annotateToolRegistration(
  server: McpServer,
  projectScope?: McpProjectScopeRuntime,
): void {
  const target = server as unknown as {
    registerTool: (name: string, cfg: Record<string, unknown>, ...rest: unknown[]) => unknown;
  };
  const original = target.registerTool.bind(server);
  target.registerTool = (name, cfg, ...rest) => {
    if (!isToolEnabled(name)) return undefined;
    if (
      !GLOBAL_PROJECT_TOOLS.has(name) &&
      cfg.inputSchema &&
      typeof cfg.inputSchema === 'object' &&
      !Array.isArray(cfg.inputSchema) &&
      !Object.prototype.hasOwnProperty.call(cfg.inputSchema, 'projectId')
    ) {
      cfg.inputSchema = {
        ...(cfg.inputSchema as Record<string, unknown>),
        projectId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'Optional persisted project ID for this request; does not change global selection.',
          ),
      };
    }
    // Cache hints: spread toolCacheHintMeta(name) into every tool config
    // (matches the resources.ts integration pattern). Stable tool definitions
    // get a long TTL; tools reflecting live project state get a short TTL.
    cfg._meta = {
      ...(cfg._meta as Record<string, unknown> | undefined),
      ...toolCacheHintMeta(name)._meta,
    };
    const existing = cfg.annotations as Record<string, unknown> | undefined;
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
    cfg.annotations = {
      title,
      ...existing,
      ...annotations,
    };
    const handler = rest[0];
    if (typeof handler === 'function') {
      rest[0] = (async (...args: unknown[]) => {
        try {
          const firstArg = args[0];
          const shouldScope = projectScope !== undefined && !GLOBAL_PROJECT_TOOLS.has(name);
          const projectId = shouldScope
            ? firstArg && typeof firstArg === 'object' && !Array.isArray(firstArg)
              ? (firstArg as Record<string, unknown>).projectId
              : undefined
            : undefined;
          const handlerArgs =
            shouldScope && firstArg && typeof firstArg === 'object' && !Array.isArray(firstArg)
              ? [
                  {
                    ...(firstArg as Record<string, unknown>),
                    projectId: undefined,
                  },
                  ...args.slice(1),
                ]
              : args;
          const invoke = async (): Promise<unknown> => handler(...handlerArgs);
          const measured = await measureInvocation(name, firstArg, () =>
            shouldScope ? projectScope!.run(projectId, invoke) : invoke(),
          );
          const value = addActionableFailureDetails(measured.value);
          if (process.env.PROJECTMIND_METRICS !== '1') return value;
          if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
          return {
            ...value,
            _meta: {
              ...((value as Record<string, unknown>)._meta as Record<string, unknown> | undefined),
              metrics: measured.metrics,
            },
          };
        } catch (error) {
          return actionableMcpError(error);
        }
      }) as unknown as (...args: unknown[]) => Promise<unknown>;
    }
    const result = original(name, cfg, ...rest);
    return result;
  };
}

/**
 * Tool surface profile. `PROJECTMIND_TOOLS=all` registers the full surface
 * including generated pm_* parity tools (~130 total).
 * `PROJECTMIND_TOOLS=core` (DEFAULT) skips parity tools so clients
 * with a small active-tool budget (e.g. Cursor's limit) can use ProjectMind.
 * The run_cli bridge always remains available as escape hatch.
 * Set `PROJECTMIND_TOOLS=all` to enable the full parity surface.
 */
export function shouldRegisterParityTools(): boolean {
  return getMcpProfile() === 'full';
}

export type McpProfile = 'core' | 'review' | 'security' | 'maintenance' | 'full';

/** User-facing profile names accepted by the CLI and environment. */
export const MCP_PROFILE_NAMES = ['core', 'review', 'security', 'maintenance', 'full'] as const;

/**
 * Normalize the historical `all` spelling to the canonical `full` profile.
 * Keeping this in one place prevents the CLI, stdio server, and resources
 * from advertising subtly different profile semantics.
 */
export function normalizeMcpProfile(value: string): McpProfile | null {
  const requested = value.trim().toLowerCase();
  if (requested === 'all') return 'full';
  return (MCP_PROFILE_NAMES as readonly string[]).includes(requested)
    ? (requested as McpProfile)
    : null;
}

const PROFILE_TOOLS: Record<Exclude<McpProfile, 'full'>, ReadonlySet<string>> = {
  core: new Set(MCP_CORE_TOOL_NAMES),
  review: new Set([
    'check_coherence',
    'get_context',
    'analyze_impact',
    'check_architecture',
    'check_contracts',
    'semantic_search',
    'record_search_feedback',
    'get_session_insights',
    'predict_bug_surface',
    'ask_codebase',
    'find_symbol_references',
    'find_symbol_definition',
    'suggest_next_files',
    'prove_claim',
    'verify_freshness',
    'get_source_range',
    'get_source_symbol_range',
    'get_invocation_metrics',
    'review_project',
    'get_canonical_example',
    'resource_subscribe',
    'resource_unsubscribe',
  ]),
  security: new Set([
    'check_coherence',
    'get_context',
    'scan_cves',
    'analyze_taint',
    'record_taint',
    'get_data_flows',
    'get_resource_flows',
    'prove_claim',
    'verify_freshness',
    'run_cli',
    'resource_subscribe',
    'resource_unsubscribe',
  ]),
  maintenance: new Set([
    'get_context',
    'debt_report',
    'scale_report',
    'genome_score',
    'find_circular_deps',
    'get_dependency_graph',
    'get_file_status',
    'sync_context',
    'agent_locks',
    'predict_merge_risk',
    'arbitrate_agents',
    'find_patterns',
    'recommend_skills',
    'run_cli',
    'resource_subscribe',
    'resource_unsubscribe',
  ]),
};

export function getMcpProfile(): McpProfile {
  return normalizeMcpProfile(process.env.PROJECTMIND_TOOLS || 'core') ?? 'core';
}

export function isToolEnabled(name: string): boolean {
  const profile = getMcpProfile();
  if (profile === 'full') return true;
  if (name.startsWith('pm_')) return false;
  return PROFILE_TOOLS[profile].has(name);
}

/** Return the deterministic dedicated-tool list advertised by a profile. */
export function getMcpProfileTools(profile: McpProfile = getMcpProfile()): readonly string[] {
  if (profile === 'full') return [...MCP_CORE_TOOL_NAMES, 'pm_* parity tools'];
  return [...PROFILE_TOOLS[profile]].sort((left, right) => left.localeCompare(right));
}
