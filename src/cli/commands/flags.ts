import { reportSuppressedError } from '../../utils/errors.js';
import { Command } from 'commander';
import { withService, asyncHandler, output, logger } from '@/cli/utils/shared.js';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { loadConfig } from '@/cli/utils/shared.js';
import { confineToProject } from '@/mcp/tools/_shared.js';

interface FeatureFlag {
  name: string;
  file: string;
  line: number;
  type: 'if' | 'ternary' | 'function' | 'config' | 'env';
  framework: string; // Allow any string for framework
  defaultValue?: boolean;
  environments?: string[];
  stale?: boolean;
  lastModified?: string;
  references: number;
}

export function createFlagsCommand(): Command {
  const flagsCmd = new Command('flags')
    .description('Audit feature flags: usage, staleness, coverage, cleanup')
    .option('--stale-days <n>', 'Days to consider flag stale', '90')
    .option(
      '--framework <fw>',
      'Framework filter: unleash|launchdarkly|custom|homegrown|all',
      'all',
    )
    .option('--unused', 'Show potentially unused flags')
    .option('--coverage', 'Show flag coverage by environment')
    .option('--format <fmt>', 'Output: text|json|markdown', 'text')
    .option('-o, --output <file>', 'Write to file')
    .action(
      asyncHandler(
        async (opts: {
          staleDays: string;
          framework: string;
          unused: boolean;
          coverage: boolean;
          format: string;
          output: string;
        }) => {
          await withService(['scale'], async (_ctx, services) => {
            const scale = services.scale!;
            const framework = opts.framework.toLowerCase();
            if (!['unleash', 'launchdarkly', 'custom', 'homegrown', 'all'].includes(framework)) {
              throw new Error(
                `--framework must be unleash, launchdarkly, custom, homegrown, or all: ${opts.framework}`,
              );
            }

            const staleDays = Number.parseInt(opts.staleDays, 10);
            if (!Number.isSafeInteger(staleDays) || staleDays < 0 || staleDays > 3650) {
              throw new Error(
                `--stale-days must be an integer between 0 and 3650: ${opts.staleDays}`,
              );
            }
            if (!['text', 'json', 'markdown'].includes(opts.format)) {
              throw new Error(`--format must be text, json, or markdown: ${opts.format}`);
            }
            const outputPath = opts.output
              ? confineToProject(opts.output, loadConfig().projectRoot)
              : undefined;

            if (opts.format === 'text') {
              output.section('Feature Flag Audit');
              output.kv('Stale threshold', `${staleDays} days`);
              output.kv('Framework', opts.framework);
            }

            const report = scale.getScaleReport();
            const allFiles = report.modules.flatMap((m) => m.files || []);
            const tsFiles = allFiles.filter(
              (f) => f.language === 'typescript' || f.language === 'javascript',
            );

            const flags: FeatureFlag[] = [];

            for (const file of tsFiles) {
              try {
                const content = readFileSync(file.path, 'utf-8');
                const found = findFeatureFlags(content, file.relativePath, file.path);
                flags.push(...found);
              } catch (error) {
                reportSuppressedError(error, 'Intentional fallback src/cli/commands/flags.ts:86');
                // Skip unreadable
              }
            }

            const filteredFlags =
              framework === 'all' ? flags : flags.filter((flag) => flag.framework === framework);
            if (filteredFlags.length === 0) {
              if (opts.format === 'json') output.json({ flags: [], summary: { total: 0 } });
              else output.info('No feature flags detected');
              return;
            }

            output.kv('Total flags found', filteredFlags.length);

            // Analyze flags
            const staleThreshold = Date.now() - staleDays * 24 * 60 * 60 * 1000;

            // Resolve lastModified per source file (git last-commit date, fs mtime fallback).
            // Lazy + cached: only files that actually contain flags are queried.
            const lastModifiedCache = new Map<string, string | undefined>();
            for (const flag of flags) {
              const absPath = tsFiles.find((f) => f.relativePath === flag.file)?.path;
              if (absPath !== undefined && !lastModifiedCache.has(absPath)) {
                lastModifiedCache.set(absPath, resolveLastModified(absPath));
              }
              if (absPath !== undefined) {
                flag.lastModified = lastModifiedCache.get(absPath);
              }

              // Check if stale
              if (flag.lastModified) {
                const lastMod = new Date(flag.lastModified).getTime();
                flag.stale = lastMod < staleThreshold;
              }

              // Count references (simplified)
              flag.references = countReferences(flag.name, tsFiles);
            }

            const staleFlags = filteredFlags.filter((f) => f.stale);
            const unusedFlags = filteredFlags.filter((f) => f.references === 0);
            const byFramework = filteredFlags.reduce(
              (acc, f) => {
                acc[f.framework || 'unknown'] = (acc[f.framework || 'unknown'] || 0) + 1;
                return acc;
              },
              {} as Record<string, number>,
            );

            if (opts.format === 'json') {
              const result = {
                flags: filteredFlags,
                summary: {
                  total: filteredFlags.length,
                  stale: staleFlags.length,
                  unused: unusedFlags.length,
                  byFramework,
                },
              };
              const content = JSON.stringify(result, null, 2);
              if (outputPath) {
                writeFileSync(outputPath, content);
                output.success(`Written to ${outputPath}`);
              } else {
                output.raw(content);
              }
              return;
            }

            if (opts.format === 'markdown') {
              const content = generateMarkdownFlags(filteredFlags, staleFlags, unusedFlags);
              if (outputPath) {
                writeFileSync(outputPath, content);
                output.success(`Written to ${outputPath}`);
              } else {
                output.raw(content);
              }
              return;
            }

            // Text format
            output.section(`Feature Flags (${filteredFlags.length} total)`);

            output.kv(
              'By framework',
              Object.entries(byFramework)
                .map(([k, v]) => `${k}: ${v}`)
                .join(', '),
            );
            output.kv('Stale flags', staleFlags.length);
            output.kv('Unused flags', unusedFlags.length);

            if (staleFlags.length > 0) {
              output.section(`Stale Flags (>${staleDays} days)`);
              for (const flag of staleFlags.slice(0, 20)) {
                output.kv(
                  `  ⏰ ${flag.name}`,
                  `${flag.file}:${flag.line} | ${flag.framework || 'unknown'} | Default: ${flag.defaultValue?.toString() || 'unknown'}`,
                );
              }
            }

            if (opts.unused && unusedFlags.length > 0) {
              output.section(`Potentially Unused Flags`);
              for (const flag of unusedFlags.slice(0, 20)) {
                output.kv(`  🔍 ${flag.name}`, `${flag.file}:${flag.line} | No references found`);
              }
            }

            if (opts.coverage) {
              output.section('Environment Coverage');
              const withEnvs = filteredFlags.filter(
                (f) => f.environments && f.environments.length > 0,
              );
              output.kv('Flags with env config', withEnvs.length);
              for (const flag of withEnvs.slice(0, 15)) {
                output.kv(`  ${flag.name}`, flag.environments?.join(', ') || 'none');
              }
            }

            output.section('Recommendations');
            if (staleFlags.length > 0) {
              output.kv(
                `  🧹 Clean up ${staleFlags.length} stale flags`,
                'Consider removing or updating',
              );
            }
            if (unusedFlags.length > 0) {
              output.kv(
                `  🗑️ Remove ${unusedFlags.length} unused flags`,
                'No references found in codebase',
              );
            }
            if (filteredFlags.some((f) => !f.environments || f.environments.length === 0)) {
              output.kv(
                `  🌍 Add environment config`,
                `${filteredFlags.filter((f) => !f.environments || f.environments.length === 0).length} flags lack environment config`,
              );
            }

            if (outputPath) {
              writeFileSync(
                outputPath,
                JSON.stringify(
                  {
                    flags: filteredFlags,
                    summary: {
                      total: filteredFlags.length,
                      stale: staleFlags.length,
                      unused: unusedFlags.length,
                      byFramework,
                    },
                  },
                  null,
                  2,
                ),
              );
              output.success(`Written to ${outputPath}`);
            }
          });
        },
      ),
    );

  return flagsCmd;
}

function findFeatureFlags(content: string, relativePath: string, _filePath: string): FeatureFlag[] {
  const flags: FeatureFlag[] = [];
  const lines = content.split(/\r?\n/);

  // Common feature flag patterns
  const patterns = [
    // Unleash
    {
      regex: /isEnabled\s*\(\s*['"]([^'"]+)['"]/g,
      framework: 'unleash',
      type: 'function' as const,
    },
    {
      regex: /getVariant\s*\(\s*['"]([^'"]+)['"]/g,
      framework: 'unleash',
      type: 'function' as const,
    },
    // LaunchDarkly
    {
      regex: /variation\s*\(\s*['"]([^'"]+)['"]/g,
      framework: 'launchdarkly',
      type: 'function' as const,
    },
    {
      regex: /boolVariation\s*\(\s*['"]([^'"]+)['"]/g,
      framework: 'launchdarkly',
      type: 'function' as const,
    },
    // Custom/Homegrown
    { regex: /(?:flags|features|toggles)\.(\w+)/g, framework: 'custom', type: 'config' as const },
    { regex: /process\.env\.(\w+_ENABLED|\w+_FLAG)/g, framework: 'custom', type: 'env' as const },
    { regex: /featureFlags\.(\w+)/g, framework: 'custom', type: 'config' as const },
    // Generic if/ternary patterns
    {
      regex: /if\s*\(\s*['"]([^'"]+)['"]\s*===?\s*['"]true['"]/g,
      framework: 'homegrown',
      type: 'if' as const,
    },
    {
      regex: /\w+\s*\?\s*.*\s*:\s*.*\s*\?\s*['"]([^'"]+)['"]/g,
      framework: 'homegrown',
      type: 'ternary' as const,
    },
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { regex, framework, type } of patterns) {
      let match;
      while ((match = regex.exec(line)) !== null) {
        const flagName = match[1] || match[0];
        flags.push({
          name: flagName,
          file: relativePath,
          line: i + 1,
          type,
          framework,
          defaultValue: line.includes('true') || line.includes('enabled'),
          references: 0,
        });
      }
    }
  }

  // Also check for flag definitions in config files
  if (
    relativePath.includes('config') ||
    relativePath.includes('flag') ||
    relativePath.includes('feature')
  ) {
    const configFlags = extractConfigFlags(content, relativePath);
    flags.push(...configFlags);
  }

  return flags;
}

/**
 * Last-modified date for a file: git last-commit date when available,
 * filesystem mtime as fallback. Never fabricates — undefined when both fail.
 */
function resolveLastModified(absolutePath: string): string | undefined {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cI', '--', absolutePath], {
      cwd: dirname(absolutePath),
      encoding: 'utf-8',
    }).trim();
    if (out) return out;
  } catch (error) {
    reportSuppressedError(error, 'Intentional fallback src/cli/commands/flags.ts:342');
    // Not a git repo / git missing / file untracked: fall through to mtime.
  }
  try {
    return statSync(absolutePath).mtime.toISOString();
  } catch {
    return undefined;
  }
}

function extractConfigFlags(content: string, relativePath: string): FeatureFlag[] {
  const flags: FeatureFlag[] = [];

  // JSON/YAML/JS config objects
  const objRegex = /(\w+)\s*:\s*\{[\s\S]*?enabled\s*:\s*(true|false)/g;
  let match;
  while ((match = objRegex.exec(content)) !== null) {
    flags.push({
      name: match[1],
      file: relativePath,
      line: content.substring(0, match.index).split(/\r?\n/).length,
      type: 'config',
      framework: 'custom',
      defaultValue: match[2] === 'true',
      references: 0,
    });
  }

  return flags;
}

function countReferences(flagName: string, files: Array<{ path: string }>): number {
  let count = 0;

  for (const file of files.slice(0, 100)) {
    try {
      const content = readFileSync(file.path, 'utf-8');
      // Simple reference counting
      const escaped = flagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`\\b${escaped}\\b`, 'g');
      const matches = content.match(regex);
      if (matches) count += matches.length;
    } catch {
      logger.debug(`Skipping file in flag reference count: ${file.path}`);
    }
  }

  return count;
}

function generateMarkdownFlags(
  flags: FeatureFlag[],
  stale: FeatureFlag[],
  unused: FeatureFlag[],
): string {
  const lines = [
    '# Feature Flag Audit Report',
    '',
    `**Generated:** ${new Date().toISOString().split('T')[0]}`,
    `**Total Flags:** ${flags.length} | **Stale:** ${stale.length} | **Unused:** ${unused.length}`,
    '',
    '## All Flags',
    '',
    '| Name | File | Line | Type | Framework | Stale | Unused |',
    '|------|------|------|------|-----------|-------|--------|',
  ];

  for (const flag of flags) {
    lines.push(
      `| ${flag.name} | ${flag.file} | ${flag.line} | ${flag.type} | ${flag.framework || 'unknown'} | ${flag.stale ? '🔴' : '🟢'} | ${flag.references === 0 ? '🔴' : '🟢'} |`,
    );
  }

  if (stale.length > 0) {
    lines.push('', '## Stale Flags', '');
    for (const flag of stale) {
      lines.push(
        `- **${flag.name}** (${flag.file}:${flag.line}) - Last modified: ${flag.lastModified || 'unknown'}`,
      );
    }
  }

  if (unused.length > 0) {
    lines.push('', '## Unused Flags', '');
    for (const flag of unused) {
      lines.push(`- **${flag.name}** (${flag.file}:${flag.line})`);
    }
  }

  return lines.join('\n');
}
