import type { CompleteToolAnnotations } from './guard.js';

/** CLI paths that are genuinely read-only when no write-capable flag is set. */
const READ_ONLY_PATHS = new Set([
  'scale',
  'context',
  'search',
  'impact',
  'debt-prioritize',
  'license',
  'license check',
  'license report',
  'graph',
  'graph circular',
  'graph feature-map',
  'graph verify',
  'graph diff',
  'heatmap',
  'ownership',
  'dedup',
  'git-insights',
  'refs',
  'def',
  'workspace',
  'find-circular-deps',
  'migrate',
  'migrate check-deps',
  'migrate jest-to-vitest',
  'migrate typescript',
  'parser-capabilities',
  'debug',
  'debug cache',
  'debug patterns',
  'debug imports',
  'debug db',
  'debug agent-touched',
  'debug circular-deps',
  'debug profile',
  'agent status',
  'agent coverage',
  'project list',
  'project current',
  'data-flow list',
  'data-flow resource',
  'embed generate',
  'embed similar',
  'embed provider',
  'taint analyze',
  'trace show',
  'proof',
  'proof verify',
  'proof claim',
  'context-budget',
  'autopilot pre-commit',
  'contract-test run',
  'deps-fresh',
  'secrets-life',
  'sbom',
  'docgen',
  'docgen readme',
  'docgen api',
  'trace convert',
]);

/** Flags that can write an artifact or otherwise mutate project state. */
const WRITE_OPTIONS = new Set([
  'output',
  'history',
  'sign',
  'auto-fix',
  'apply',
  'write',
  'generate',
  'repair-graph',
  'uninstall',
  'no-dry-run',
]);

/** Paths whose default action can delete, overwrite, or rewrite project data. */
const DESTRUCTIVE_PATHS = new Set([
  'layers',
  'structural-search replace',
  'refactor remove-unused',
  'refactor autofix',
  'adr new',
  'adr index',
  'contract-test generate',
  'project delete',
  'data-flow clear',
  'trace clear',
  'debt clear',
  'debt clear-patterns',
  'doctor clean-debt',
  'doctor rebuild-index',
  'autopilot install-hooks',
  'testgen',
  'testgen scaffold',
]);

/** Roots/options that may call an LLM, package registry, or external binary. */
const OPEN_WORLD_ROOTS = new Set(['check', 'deps-fresh', 'embed']);
const OPEN_WORLD_OPTIONS = new Set([
  'deep',
  'audit',
  'sign',
  'openai-api-key',
  'model-path',
  'transformers-model',
]);

function hasAnyOption(optionNames: string[], candidates: Set<string>): boolean {
  return optionNames.some((option) => candidates.has(option));
}

/** Full annotation set for a parity tool identified by its CLI path/options. */
export function parityAnnotations(
  path: string[],
  optionNames: string[] = [],
): CompleteToolAnnotations {
  const key = path.join(' ');
  const root = path[0] ?? '';
  const writeCapable = hasAnyOption(optionNames, WRITE_OPTIONS);
  const destructivePath = DESTRUCTIVE_PATHS.has(key);
  const destructiveOption = hasAnyOption(
    optionNames,
    new Set([
      'output',
      'sign',
      'auto-fix',
      'apply',
      'write',
      'generate',
      'repair-graph',
      'uninstall',
      'no-dry-run',
    ]),
  );
  const openWorld = OPEN_WORLD_ROOTS.has(root) || hasAnyOption(optionNames, OPEN_WORLD_OPTIONS);

  if (READ_ONLY_PATHS.has(key) && !writeCapable && !destructivePath) {
    return {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: openWorld,
    };
  }

  // A generated tool may expose optional flags such as --output or --history;
  // classify the registration for the strongest behavior it can perform.
  return {
    readOnlyHint: false,
    destructiveHint: destructivePath || destructiveOption,
    idempotentHint: false,
    openWorldHint: openWorld,
  };
}
