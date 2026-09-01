import { withService, asyncHandler, output, loadConfig } from '@/cli/utils/shared.js';
import { Command } from 'commander';

import { readFileSync, writeFileSync } from 'node:fs';

import { join } from 'node:path';

import { getStatement } from '../../storage/database.js';

interface ModuleCoupling {
  name: string;
  path: string;
  afferent: number; // Ca - incoming dependencies
  efferent: number; // Ce - outgoing dependencies
  instability: number; // I = Ce / (Ca + Ce)
  abstractness: number; // A = abstract classes / total classes
  distanceFromMain: number; // D = |A + I - 1|
  afferentModules: string[];
  efferentModules: string[];
  isGodModule: boolean;
  isLeafModule: boolean;
}

interface ModuleInfoWithFiles {
  path: string;
  name: string;
  files: Array<{
    relativePath: string;
    imports?: Array<{ source: string }>;
  }>;
}

export function createCouplingCommand(): Command {
  const couplingCmd = new Command('coupling')
    .description('Analyze module coupling metrics (Ca, Ce, Instability, Abstractness)')
    .option('--threshold <n>', 'Instability threshold for warnings', '0.8')
    .option('--format <fmt>', 'Output: text|json|mermaid|d3', 'text')
    .option('-o, --output <file>', 'Write to file')
    .option('--threshold-abstractness <n>', 'Abstractness threshold', '0.3')
    .action(
      asyncHandler(
        async (opts: {
          threshold: string;
          format: string;
          output: string;
          thresholdAbstractness: string;
        }) => {
          await withService(['scale'], async (ctx, services) => {
            const scale = services.scale!;

            output.section('Module Coupling Analysis');
            output.kv('Instability threshold', opts.threshold);
            output.kv('Abstractness threshold', opts.thresholdAbstractness);

            const report = scale.getScaleReport();
            const modules = report.modules;

            if (modules.length === 0) {
              output.warn('No modules found. Run "projectmind scan" first.');
              return;
            }

            // REAL import edges from the knowledge graph (resolved at scan time).
            // Replaces the previous heuristic that relied on unpopulated
            // per-file import lists.
            const edgeRows = getStatement(
              `SELECT f.relative_path AS from_path, i.resolved_path AS to_path
           FROM imports i JOIN files f ON f.id = i.file_id
           WHERE i.resolved_path IS NOT NULL AND f.project_id = ?`,
            ).all(ctx.kg.getCurrentProjectId()) as Array<{ from_path: string; to_path: string }>;
            const realEdges = edgeRows.map((r) => ({ from: r.from_path, to: r.to_path }));
            output.kv('Resolved import edges', realEdges.length);

            // Build module dependency graph
            const moduleCoupling = calculateCoupling(modules, realEdges);

            const instabilityThreshold = parseFloat(opts.threshold);
            const abstractnessThreshold = parseFloat(opts.thresholdAbstractness);

            // Identify problematic modules
            const highInstability = moduleCoupling.filter(
              (m) => m.instability > instabilityThreshold,
            );
            const lowAbstractness = moduleCoupling.filter(
              (m) => m.abstractness < abstractnessThreshold && m.instability > 0.5,
            );
            const godModules = moduleCoupling.filter((m) => m.isGodModule);
            const leafModules = moduleCoupling.filter((m) => m.isLeafModule);

            if (opts.format === 'json') {
              const result = {
                modules: moduleCoupling,
                summary: {
                  total: moduleCoupling.length,
                  highInstability: highInstability.length,
                  lowAbstractness: lowAbstractness.length,
                  godModules: godModules.length,
                  leafModules: leafModules.length,
                },
              };
              const content = JSON.stringify(result, null, 2);
              if (opts.output) {
                writeFileSync(opts.output, content);
                output.success(`Written to ${opts.output}`);
              } else {
                output.info(content);
              }
              return;
            }

            if (opts.format === 'mermaid') {
              const content = generateMermaidCoupling(moduleCoupling);
              if (opts.output) {
                writeFileSync(opts.output, content);
                output.success(`Written to ${opts.output}`);
              } else {
                output.info(content);
              }
              return;
            }

            if (opts.format === 'd3') {
              const content = generateD3Coupling(moduleCoupling);
              if (opts.output) {
                writeFileSync(opts.output, content);
                output.success(`Written to ${opts.output}`);
              } else {
                output.info(content);
              }
              return;
            }

            // Text format
            output.section(`Module Coupling Metrics (${moduleCoupling.length} modules)`);

            // Summary table
            output.info('Module                  | Ca  | Ce  | I    | A    | D    | Status');
            output.info('------------------------|-----|-----|------|------|------|-------');
            for (const m of moduleCoupling.sort((a, b) => b.instability - a.instability)) {
              const status = m.isGodModule
                ? '🔴 GOD'
                : m.instability > instabilityThreshold
                  ? '🟠 UNSTABLE'
                  : m.abstractness < abstractnessThreshold && m.instability > 0.5
                    ? '🟡 CONCRETE'
                    : m.isLeafModule
                      ? '🟢 LEAF'
                      : '⚪ OK';
              output.info(
                `${m.name.padEnd(24)} | ${String(m.afferent).padStart(3)} | ${String(m.efferent).padStart(3)} | ${m.instability.toFixed(2).padStart(4)} | ${m.abstractness.toFixed(2).padStart(4)} | ${m.distanceFromMain.toFixed(2).padStart(4)} | ${status}`,
              );
            }

            output.section('Problematic Modules');

            if (godModules.length > 0) {
              output.kv('🔴 God Modules (high Ca + high Ce)', godModules.length);
              for (const m of godModules) {
                output.kv(
                  `  ${m.name}`,
                  `Ca=${m.afferent} Ce=${m.efferent} I=${m.instability.toFixed(2)} A=${m.abstractness.toFixed(2)}`,
                );
              }
            }

            if (highInstability.length > 0) {
              output.kv(`🟠 High Instability (>${instabilityThreshold})`, highInstability.length);
              for (const m of highInstability.filter((m) => !godModules.includes(m))) {
                output.kv(
                  `  ${m.name}`,
                  `I=${m.instability.toFixed(2)} (Ca=${m.afferent} Ce=${m.efferent})`,
                );
              }
            }

            if (lowAbstractness.length > 0) {
              output.kv(
                `🟡 Low Abstractness (<${abstractnessThreshold}) with instability`,
                lowAbstractness.length,
              );
              for (const m of lowAbstractness) {
                output.kv(
                  `  ${m.name}`,
                  `A=${m.abstractness.toFixed(2)} I=${m.instability.toFixed(2)}`,
                );
              }
            }

            if (leafModules.length > 0) {
              output.kv('🟢 Leaf Modules (Ce=0)', leafModules.length);
              for (const m of leafModules.slice(0, 10)) {
                output.kv(`  ${m.name}`, `Ca=${m.afferent}`);
              }
            }

            // Distance from main sequence
            const farFromMain = moduleCoupling.filter((m) => m.distanceFromMain > 0.5);
            if (farFromMain.length > 0) {
              output.kv(`📐 Far from Main Sequence (D>0.5)`, farFromMain.length);
              for (const m of farFromMain.slice(0, 10)) {
                output.kv(
                  `  ${m.name}`,
                  `D=${m.distanceFromMain.toFixed(2)} A=${m.abstractness.toFixed(2)} I=${m.instability.toFixed(2)}`,
                );
              }
            }

            output.section('Recommendations');
            if (godModules.length > 0) {
              output.kv('God Modules', 'Consider splitting into smaller, focused modules');
            }
            if (highInstability.length > 0) {
              output.kv(
                'High Instability',
                'Reduce outgoing dependencies (Ce) or increase incoming (Ca)',
              );
            }
            if (lowAbstractness.length > 0) {
              output.kv(
                'Concrete Unstable Modules',
                'Add abstractions (interfaces/abstract classes) or reduce dependencies',
              );
            }
            if (farFromMain.length > 0) {
              output.kv(
                'Far from Main Sequence',
                'Balance abstractness and instability (aim for D≈0)',
              );
            }

            if (opts.output) {
              const result = {
                modules: moduleCoupling,
                summary: {
                  total: moduleCoupling.length,
                  highInstability: highInstability.length,
                  lowAbstractness: lowAbstractness.length,
                  godModules: godModules.length,
                  leafModules: leafModules.length,
                },
              };
              writeFileSync(opts.output, JSON.stringify(result, null, 2));
              output.success(`Written to ${opts.output}`);
            }
          });
        },
      ),
    );

  return couplingCmd;
}

function calculateCoupling(
  modules: ModuleInfoWithFiles[],
  realEdges?: Array<{ from: string; to: string }>,
): ModuleCoupling[] {
  // Build adjacency lists
  const afferent = new Map<string, Set<string>>(); // Who imports this module
  const efferent = new Map<string, Set<string>>(); // What this module imports

  for (const module of modules) {
    afferent.set(module.path, new Set());
    efferent.set(module.path, new Set());
  }

  const moduleByFile = new Map<string, string>();
  for (const module of modules) {
    for (const file of module.files || []) {
      moduleByFile.set(file.relativePath.replace(/\\/g, '/'), module.path);
    }
  }
  const findModuleForFilePath = (filePath: string): ModuleInfoWithFiles | undefined => {
    const normalized = filePath.replace(/\\/g, '/');
    const exact = moduleByFile.get(normalized);
    if (exact) return modules.find((m) => m.path === exact);
    // Longest-prefix match for directory-level modules
    let best: ModuleInfoWithFiles | undefined;
    let bestLen = -1;
    for (const m of modules) {
      if (normalized.startsWith(m.path) && m.path.length > bestLen) {
        best = m;
        bestLen = m.path.length;
      }
    }
    return best;
  };

  const addEdge = (fromModule: string, toModule: string): void => {
    if (
      fromModule !== toModule &&
      modules.some((m) => m.path === fromModule) &&
      modules.some((m) => m.path === toModule)
    ) {
      efferent.get(fromModule)?.add(toModule);
      afferent.get(toModule)?.add(fromModule);
    }
  };

  if (realEdges && realEdges.length > 0) {
    // Primary path: real resolved edges recorded during scan.
    for (const edge of realEdges) {
      const fromModule = findModuleForFilePath(edge.from);
      const toModule = findModuleForFilePath(edge.to);
      if (fromModule && toModule) addEdge(fromModule.path, toModule.path);
    }
  } else {
    // Fallback (pre-scan databases): per-file import lists.
    for (const module of modules) {
      for (const file of module.files || []) {
        const imports = file.imports || [];
        for (const imp of imports) {
          const targetModule = findModuleForImport(imp.source, modules);
          if (targetModule && targetModule.path !== module.path) {
            addEdge(module.path, targetModule.path);
          }
        }
      }
    }
  }

  const results: ModuleCoupling[] = [];

  for (const module of modules) {
    const Ca = afferent.get(module.path)?.size || 0;
    const Ce = efferent.get(module.path)?.size || 0;
    const total = Ca + Ce;
    const instability = total > 0 ? Ce / total : 0;

    // Real abstractness from source text:
    // A = (interfaces + abstract classes) / (interfaces + abstract + concrete classes).
    const abstractness = computeAbstractness(module.files || [], loadConfig().projectRoot);

    const distanceFromMain = Math.abs(abstractness + instability - 1);

    const isGodModule = Ca > 5 && Ce > 5; // High incoming and outgoing
    const isLeafModule = Ce === 0 && Ca > 0;

    results.push({
      name: module.path,
      path: module.path,
      afferent: Ca,
      efferent: Ce,
      instability,
      abstractness,
      distanceFromMain,
      afferentModules: Array.from(afferent.get(module.path) || []),
      efferentModules: Array.from(efferent.get(module.path) || []),
      isGodModule,
      isLeafModule,
    });
  }

  return results;
}

function findModuleForImport(
  importSource: string,
  modules: ModuleInfoWithFiles[],
): ModuleInfoWithFiles | null {
  // Skip external packages
  if (
    !importSource.startsWith('.') &&
    !importSource.startsWith('@/') &&
    !importSource.startsWith('@/')
  ) {
    return null;
  }

  // For @/ aliases, resolve to module
  for (const module of modules) {
    // Check if any file in module matches
    for (const file of module.files || []) {
      const fileImportPath = getImportPath(file.relativePath);
      if (importSource === fileImportPath || importSource.endsWith(fileImportPath)) {
        return module;
      }
    }
  }

  return null;
}

function getImportPath(relativePath: string): string {
  return relativePath.replace(/\.ts$/, '').replace(/\\/g, '/');
}

function generateMermaidCoupling(modules: ModuleCoupling[]): string {
  const lines = ['graph TD'];

  // Add module nodes with styling based on instability
  for (const m of modules) {
    const id = m.name.replace(/[^a-zA-Z0-9]/g, '_');
    const color = m.instability > 0.8 ? '#ffcdd2' : m.instability > 0.5 ? '#fff9c4' : '#c8e6c9';
    const god = m.isGodModule ? ' 🔴' : '';
    lines.push(`  ${id}["${m.name}${god}"]`);
    lines.push(`  style ${id} fill:${color}`);
  }

  // Add edges for efferent dependencies
  for (const m of modules) {
    const fromId = m.name.replace(/[^a-zA-Z0-9]/g, '_');
    for (const targetPath of m.efferentModules) {
      const targetModule = modules.find((mod) => mod.path === targetPath);
      if (targetModule) {
        const toId = targetModule.name.replace(/[^a-zA-Z0-9]/g, '_');
        lines.push(`  ${fromId} --> ${toId}`);
      }
    }
  }

  return lines.join('\n');
}

function generateD3Coupling(modules: ModuleCoupling[]): string {
  return JSON.stringify(
    {
      nodes: modules.map((m) => ({
        id: m.name,
        name: m.name,
        Ca: m.afferent,
        Ce: m.efferent,
        instability: m.instability,
        abstractness: m.abstractness,
        distanceFromMain: m.distanceFromMain,
        isGodModule: m.isGodModule,
        isLeafModule: m.isLeafModule,
        group: m.instability > 0.8 ? 2 : m.instability > 0.5 ? 1 : 0,
      })),
      links: modules.flatMap((m) =>
        m.efferentModules
          .map((target) => {
            const targetModule = modules.find((mod) => mod.path === target);
            return targetModule
              ? {
                  source: m.name,
                  target: targetModule.name,
                  value: 1,
                }
              : null;
          })
          .filter(Boolean),
      ),
    },
    null,
    2,
  );
}

/**
 * Robert C. Martin abstractness computed from real source text:
 * A = (interfaces + abstract classes) / (interfaces + abstract + concrete classes).
 * Unreadable files are skipped; returns 0 when nothing measurable exists.
 */
function computeAbstractness(
  files: Array<{ relativePath?: string }>,
  projectRoot?: string,
): number {
  let abstractCount = 0;
  let totalCount = 0;
  for (const file of files) {
    if (!file?.relativePath) continue;
    const absPath = projectRoot ? join(projectRoot, file.relativePath) : file.relativePath;
    let content: string;
    try {
      content = readFileSync(absPath, 'utf-8');
    } catch {
      continue;
    }
    for (const m of content.matchAll(/\b(?:(abstract)\s+)?(class|interface)\b/g)) {
      totalCount++;
      if (m[1] === 'abstract' || m[2] === 'interface') {
        abstractCount++;
      }
    }
  }
  return totalCount > 0 ? Math.round((abstractCount / totalCount) * 100) / 100 : 0;
}
