import { resolve } from 'node:path';

/** Environment marker set only on CLI processes spawned by the MCP bridge. */
export const MCP_CLI_BRIDGE_ENV = 'PROJECTMIND_MCP_CLI_BRIDGE';

const BOOTSTRAP_COMMANDS = new Set(['init', 'init-mcp', 'mcp-init']);

/**
 * Return an explicitly supplied --root value without interpreting other CLI
 * options. Commander performs the final syntax validation; this helper is
 * intentionally limited to selecting the security boundary for startup.
 */
export function getExplicitRoot(argv: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;
    if (token === '--root' || token === '-r') return argv[index + 1];
    if (token.startsWith('--root=')) return token.slice('--root='.length);
  }
  return undefined;
}

/**
 * Resolve the root used by startup path confinement. An explicit root is the
 * boundary for a direct CLI invocation; otherwise the configured root is
 * supplied by the caller.
 */
export function getStartupProjectRoot(argv: readonly string[], configuredRoot: string): string {
  const explicitRoot = getExplicitRoot(argv);
  return explicitRoot === undefined ? configuredRoot : resolve(explicitRoot);
}

/**
 * Direct CLI commands may intentionally target another checkout with --root.
 * The MCP bridge sets MCP_CLI_BRIDGE_ENV, so an agent cannot use the same
 * startup exception to escape the project root pinned by the MCP server.
 */
export function allowRootOutsideProject(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env[MCP_CLI_BRIDGE_ENV] === '1') return false;
  return BOOTSTRAP_COMMANDS.has(argv[0] ?? '') || getExplicitRoot(argv) !== undefined;
}
