import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from './types.js';
import type { ScaleReport } from '@/core/scale/reporting/types.js';
import { renderModuleSvg, renderModulePng } from '@/cli/commands/graph-render.js';

/**
 * Cross-Layer Architecture Diagram.
 *
 * Renders the live module landscape as SVG, PNG or Mermaid with:
 * - Layer configuration and color-coding for cross-layer boundary visibility
 * - Circular dependency detection and highlighting
 * - Module depth limiting and narrowing by module name
 */

/** Output formats supported by export_architecture_diagram. */
export type ArchitectureDiagramFormat = 'svg' | 'png' | 'mermaid';

/** Layer identifiers for cross-layer boundary coloring. */
export type LayerName =
  'core' | 'service' | 'api' | 'presentation' | 'infrastructure' | 'cross-cutting';

/** Color mapping for each layer layer in the Mermaid diagram. */
export const LAYER_COLORS: Record<LayerName, string> = {
  core: '#1f77b4',
  service: '#ff7f0e',
  api: '#2ca02c',
  presentation: '#d62728',
  infrastructure: '#9467bd',
  'cross-cutting': '#8c564b',
};

/** Arguments for export_architecture_diagram tool. */
export type ExportArchitectureDiagramArgs = {
  format?: ArchitectureDiagramFormat;
  module?: string;
  depth?: number;
};

/** Result from export_architecture_diagram tool. */
export type ExportArchitectureDiagramResult = {
  format: ArchitectureDiagramFormat;
  content: string;
};

/** Layer assignment based on module path conventions. */
export function assignLayer(path: string): LayerName {
  const lower = path.toLowerCase();
  if (/\\b(api|controller|endpoint)\\b/.test(lower)) return 'api';
  if (/\\b(service|business|usecase)\\b/.test(lower)) return 'service';
  if (/\\b(view|component|page|ui|presentation)\\b/.test(lower)) return 'presentation';
  if (/\\b(infra|db|database|storage|file|path)\\b/.test(lower)) return 'infrastructure';
  if (/\\b(cache|logging|security|auth|config)\\b/.test(lower)) return 'cross-cutting';
  return 'core';
}

/** Interface for a module with layer metadata. */
export interface LabeledModule {
  path: string;
  name: string;
  fileCount: number;
  layer: LayerName;
  color: string;
}

/** Result of circular dependency detection. */
export interface CircularDependency {
  cycle: string[];
  length: number;
  severity: 'low' | 'medium' | 'high';
}

/** Detect cycles in a dependency graph represented as adjacency list. */
export function detectCircularDeps(adjacency: Map<string, string[]>): CircularDependency[] {
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const cycles: CircularDependency[] = [];

  function dfs(node: string, path: string[]): void {
    if (inStack.has(node)) {
      // Found a cycle — extract the cycle portion from the path
      const cycleStart = path.indexOf(node);
      if (cycleStart >= 0 && cycleStart < path.length - 1) {
        const cycle = path.slice(cycleStart);
        const severity = cycle.length > 3 ? 'high' : cycle.length > 1 ? 'medium' : 'low';
        cycles.push({
          cycle,
          length: cycle.length,
          severity,
        });
      }
      return;
    }
    if (visited.has(node)) return;

    visited.add(node);
    inStack.add(node);
    path.push(node);

    const neighbors = adjacency.get(node) || [];
    for (const neighbor of neighbors) {
      dfs(neighbor, path);
    }

    path.pop();
    inStack.delete(node);
  }

  for (const node of adjacency.keys()) {
    if (!visited.has(node)) {
      dfs(node, []);
    }
  }

  return cycles;
}

/** Sanitize a path into a Mermaid-safe node id. The `m_`/`f_` prefixes keep
 * module ids and file ids disjoint even when two paths sanitize identically
 (e.g. `a/b` and `a.b` both become `a_b`). */
function mermaidId(prefix: 'm' | 'f', path: string): string {
  return `${prefix}_${path.replace(/[^a-zA-Z0-9]/g, '_')}`;
}

/** Escape a label for use inside a double-quoted Mermaid label. */
function mermaidLabel(label: string): string {
  return label.replace(/"/g, '#quot;').replace(/\r?\n/g, ' ');
}

/** Build a valid Mermaid `graph TD` block from the report: one node per module
 * (label = name + file count) plus a `file --> module` edge per file, mirroring
 * the `pm graph --format mermaid` CLI output. Nodes are color-coded by layer. */
function buildMermaid(report: ScaleReport): string {
  // Assign layers to modules
  const labeledModules: LabeledModule[] = [];
  for (const mod of report.modules) {
    const layer = assignLayer(mod.path);
    labeledModules.push({
      path: mod.path,
      name: mod.name || mod.path,
      fileCount: mod.fileCount,
      layer,
      color: LAYER_COLORS[layer],
    });
  }

  // Build adjacency map for circular dependency detection
  const adjacency = new Map<string, string[]>();
  for (const mod of report.modules) {
    const modId = mermaidId('m', mod.path);
    const fileDeps: string[] = [];
    for (const file of mod.files ?? []) {
      const fileId = mermaidId('f', file.path);
      fileDeps.push(fileId);
    }
    adjacency.set(modId, fileDeps);
  }

  const circularDeps = detectCircularDeps(adjacency);

  const lines = ['graph TD'];
  for (const mod of labeledModules) {
    const id = mermaidId('m', mod.path);
    const label = `${mod.name} (${mod.fileCount} files)`;
    lines.push(`  ${id}["${mermaidLabel(label)}"]`);
    // Add fillcolor/style for layer coloring in Mermaid
    lines.push(`  style ${id} fill:${mod.color},stroke:#333,stroke-width:2px`);
  }
  for (const mod of report.modules) {
    const modId = mermaidId('m', mod.path);
    for (const file of mod.files ?? []) {
      lines.push(`  ${mermaidId('f', file.path)} --> ${modId}`);
    }
  }

  // Report circular dependencies at the end as a sub-graph note
  if (circularDeps.length > 0) {
    lines.push('');
    lines.push('%% Circular dependencies detected:');
    for (const dep of circularDeps) {
      const cycleLabel = dep.cycle.join(' → ') + ' → ' + dep.cycle[0];
      lines.push(`  %% ${dep.severity} severity cycle: ${cycleLabel}`);
    }
  }

  return lines.join('\n');
}

/**
 * Render the live module landscape in the requested format.
 *
 * Pure and dependency-light (only `deps.scale.getScaleReport()` is read), so
 * it is directly unit-testable — mirroring the `evaluateContracts` /
 * `semanticSearchForTool` pattern of exporting the core logic for tests.
 */
export function exportArchitectureDiagramForTool(
  deps: McpDependencies,
  args: ExportArchitectureDiagramArgs,
): ExportArchitectureDiagramResult {
  const report = deps.scale.getScaleReport();
  const format = args.format ?? 'svg';
  const filtered = filterReport(report, args.module, args.depth);

  switch (format) {
    case 'svg':
      return { format, content: renderModuleSvg(filtered) };
    case 'png': {
      const buf = renderModulePng(filtered);
      return { format, content: `data:image/png;base64,${buf.toString('base64')}` };
    }
    case 'mermaid':
      return { format, content: buildMermaid(filtered) };
  }
}

/**
 * Enhanced result that includes layer information and circular dependency warnings.
 */
export interface EnhancedArchitectureDiagramResult extends ExportArchitectureDiagramResult {
  /** Whether circular dependencies were detected in the rendered scope. */
  circularDeps: CircularDependency[];
  /** Layer distribution across rendered modules. */
  layerDistribution: Record<LayerName, number>;
}

/**
 * Export architecture diagram with enhanced cross-layer boundary information.
 */
export function exportEnhancedArchitectureDiagramForTool(
  deps: McpDependencies,
  args: ExportArchitectureDiagramArgs,
): EnhancedArchitectureDiagramResult {
  const report = deps.scale.getScaleReport();
  const format = args.format ?? 'mermaid';
  const filtered = filterReport(report, args.module, args.depth);

  const content = buildMermaid(filtered);

  // Compute layer distribution from filtered modules
  const layerDistribution: Record<LayerName, number> = {
    core: 0,
    service: 0,
    api: 0,
    presentation: 0,
    infrastructure: 0,
    'cross-cutting': 0,
  };
  for (const mod of filtered.modules) {
    const layer = assignLayer(mod.path);
    layerDistribution[layer]++;
  }

  // Detect circular deps on the full report's adjacency for accuracy
  const adjacency = new Map<string, string[]>();
  for (const mod of report.modules) {
    const modId = mermaidId('m', mod.path);
    const fileDeps: string[] = [];
    for (const file of mod.files ?? []) {
      const fileId = mermaidId('f', file.path);
      fileDeps.push(fileId);
    }
    adjacency.set(modId, fileDeps);
  }
  const circularDeps = detectCircularDeps(adjacency);

  return {
    format,
    content,
    circularDeps,
    layerDistribution,
  };
}

/**
 * Narrow the report to the requested module (exact path/name match, else
 * case-insensitive path substring) and/or the top `depth` modules by file
 * count. Returns a shallow copy so the live report is never mutated.
 *
 * @throws {Error} When `module` matches nothing (listing available modules) or
 *   the resulting module set is empty (nothing scanned yet).
 */
function filterReport(report: ScaleReport, module?: string, depth?: number): ScaleReport {
  let modules = report.modules;

  if (module) {
    const needle = module.trim();
    const exact = modules.filter((m) => m.path === needle || m.name === needle);
    const matches =
      exact.length > 0
        ? exact
        : modules.filter((m) => m.path.toLowerCase().includes(needle.toLowerCase()));
    if (matches.length === 0) {
      const available = modules
        .slice(0, 10)
        .map((m) => m.path)
        .join(', ');
      throw new Error(
        `No module matches "${module}". Available modules: ${available}${modules.length > 10 ? ', …' : ''}`,
      );
    }
    modules = matches;
  }

  if (depth !== undefined && depth >= 1) {
    modules = [...modules].sort((a, b) => b.fileCount - a.fileCount).slice(0, Math.floor(depth));
  }

  if (modules.length === 0) {
    throw new Error('No modules found in the scale report — run scan_project first.');
  }

  return { ...report, modules };
}

/**
 * Register the enhanced export_architecture_diagram tool on the MCP server.
 * Features:
 * - `format`: svg | png | mermaid (default: svg)
 * - `module`: narrow to a single module (exact path or name match, else case-insensitive substring)
 * - `depth`: cap the number of modules shown (top N by file count; default all)
 * - Returns Mermaid graph TD with layer color-coding and circular dependency warnings.
 */
export function registerExportArchitectureDiagramTool(
  server: McpServer,
  deps: McpDependencies,
): void {
  server.registerTool(
    'export_architecture_diagram',
    {
      title: 'Export Architecture Diagram',
      description:
        'Render the live module landscape as SVG, PNG (base64 data URL) or Mermaid so an agent can drop an architecture visual into a PR or doc.\n' +
        'WHEN to call: when you need a visual of the project module structure (interactive module boxes for SVG, a bar chart for PNG, a graph TD for Mermaid).\n' +
        '`module` narrows the diagram to one module (exact path or name match, else case-insensitive path substring); `depth` caps the number of modules shown (top N by file count).\n' +
        'Mermaid output includes layer color-coding and circular dependency highlights.',
      inputSchema: {
        format: z
          .enum(['svg', 'png', 'mermaid'])
          .optional()
          .describe('Output format (default "svg")'),
        module: z
          .string()
          .optional()
          .describe(
            'Narrow the diagram to a single module: exact path or name match, else case-insensitive path substring',
          ),
        depth: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Maximum number of modules to include (top N by file count; default all)'),
      },
    },
    async (args) => {
      try {
        const result = exportEnhancedArchitectureDiagramForTool(deps, {
          format: args.format,
          module: args.module,
          depth: args.depth,
        });
        // The raw artifact is returned as the text payload so the response
        // starts with `<svg`, `data:image/png;base64,` or `graph ` respectively.
        // Also include circular dep info as a structured note.
        const notes: string[] = [];
        if (result.circularDeps.length > 0) {
          for (const dep of result.circularDeps) {
            const severityLabel = {
              low: 'low',
              medium: 'medium',
              high: 'high',
            }[dep.severity];
            const cycleStr = dep.cycle.join(' → ');
            notes.push(`[${severityLabel} dep] ${cycleStr}`);
          }
        }
        const responseText = [
          result.content,
          ...(notes.length > 0 ? [`%% Circular dependencies:`, ...notes] : []),
        ].join('\n');
        return {
          content: [{ type: 'text', text: responseText }],
        };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
        };
      }
    },
  );
}
