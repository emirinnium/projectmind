import { join, resolve } from 'node:path';

/** Resolve the repository root/CLI without assuming the process cwd. */
export function resolveProjectPaths(): { projectRoot: string; cliPath: string } {
  const configuredRoot = process.env.PROJECTMIND_ROOT?.trim();
  const configuredCli = process.env.PROJECTMIND_CLI_PATH?.trim();
  // Do not probe arbitrary filesystem paths here: Next.js would trace the
  // whole repository into the server bundle. Production/CI should provide
  // PROJECTMIND_ROOT or PROJECTMIND_CLI_PATH; local web runs use the layout
  // where the web package is a child of the repository root.
  const fallbackRoot = resolve(configuredRoot || process.cwd(), configuredRoot ? '.' : '..');
  return {
    projectRoot: fallbackRoot,
    cliPath: configuredCli ? resolve(configuredCli) : join(fallbackRoot, 'dist', 'cli.js'),
  };
}
