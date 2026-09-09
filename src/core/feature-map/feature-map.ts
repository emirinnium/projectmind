import { isTestPath } from '../../utils/test-detection.js';
import type { KnowledgeGraph } from '../../storage/knowledge-graph.js';
import type { FileInfo } from '../../storage/kg/types.js';

export interface FeatureFlow {
  from: string;
  to: string;
  importCount: number;
  examples: string[];
}

export interface FeatureCandidate {
  key: string;
  label: string;
  files: string[];
  entryFiles: string[];
  testFiles: string[];
  dependencies: string[];
  dependents: string[];
  confidence: number;
  basis: string[];
}

export interface FeatureMapReport {
  generatedAt: string;
  totalSourceFiles: number;
  totalFeatures: number;
  features: FeatureCandidate[];
  flows: FeatureFlow[];
  limitations: string[];
}

interface FeatureState extends FeatureCandidate {
  incomingInternal: Set<string>;
  testFileSet: Set<string>;
}

function sourcePath(file: FileInfo): string {
  return (file.relativePath || file.path).replace(/\\/g, '/');
}

function withoutExtension(value: string): string {
  return value.replace(/\.(?:tsx?|jsx?|mjs|cjs)$/i, '');
}

/**
 * Generate a conservative feature map from filesystem boundaries and
 * resolved imports. Labels are candidates, not inferred business concepts.
 * This makes the output useful without pretending that directory names prove
 * product semantics.
 */
export function featureKeyForPath(filePath: string): {
  key: string;
  label: string;
  confidence: number;
  basis: string[];
} {
  const normalized = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
  const parts = normalized.split('/').filter(Boolean);
  const sourceIndex = parts[0] === 'src' ? 1 : 0;

  if (parts[0] === 'src' && parts[1] === 'mcp' && parts[2] === 'tools') {
    const stem = withoutExtension(parts.at(-1) ?? 'root');
    return {
      key: `mcp-tool:${stem}`,
      label: `MCP tool ${stem}`,
      confidence: 0.96,
      basis: ['src/mcp/tools boundary', 'one tool implementation file family'],
    };
  }
  if (parts[0] === 'src' && parts[1] === 'cli' && parts[2] === 'commands') {
    const stem = withoutExtension(parts.at(-1) ?? 'root');
    return {
      key: `cli-command:${stem}`,
      label: `CLI command ${stem}`,
      confidence: 0.96,
      basis: ['src/cli/commands boundary', 'one command implementation file family'],
    };
  }
  if (parts[0] === 'src' && parts[1] === 'core' && parts[2]) {
    return {
      key: `core:${parts[2]}`,
      label: `Core ${parts[2]}`,
      confidence: 0.94,
      basis: ['src/core boundary', 'first domain directory under core'],
    };
  }
  if (parts[0] === 'src' && parts[1] === 'storage' && parts[2]) {
    return {
      key: `storage:${parts[2]}`,
      label: `Storage ${parts[2]}`,
      confidence: 0.94,
      basis: ['src/storage boundary', 'first storage subsystem directory'],
    };
  }
  if (parts[0] === 'src' && parts[1]) {
    return {
      key: `src:${parts[1]}`,
      label: `Source ${parts[1]}`,
      confidence: 0.86,
      basis: ['src boundary', 'first source directory'],
    };
  }

  const fallback = parts[sourceIndex] ?? 'root';
  return {
    key: `source:${fallback}`,
    label: `Source ${fallback}`,
    confidence: 0.7,
    basis: ['fallback path grouping; review before treating as a feature'],
  };
}

function getOrCreateFeature(
  features: Map<string, FeatureState>,
  info: ReturnType<typeof featureKeyForPath>,
): FeatureState {
  const existing = features.get(info.key);
  if (existing) return existing;
  const created: FeatureState = {
    key: info.key,
    label: info.label,
    files: [],
    entryFiles: [],
    testFiles: [],
    dependencies: [],
    dependents: [],
    confidence: info.confidence,
    basis: info.basis,
    incomingInternal: new Set<string>(),
    testFileSet: new Set<string>(),
  };
  features.set(info.key, created);
  return created;
}

function sortUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

/** Build a feature candidate and cross-feature import-flow report. */
export function buildFeatureMap(kg: KnowledgeGraph, limit = 100): FeatureMapReport {
  const safeLimit = Math.max(1, Math.min(1000, Math.trunc(limit)));
  const allFiles = kg.getAllFiles();
  const sourceFiles = allFiles.filter((file) => !isTestPath(sourcePath(file)));
  const featureByFile = new Map<string, string>();
  const features = new Map<string, FeatureState>();

  for (const file of sourceFiles) {
    const path = sourcePath(file);
    const state = getOrCreateFeature(features, featureKeyForPath(path));
    state.files.push(path);
    featureByFile.set(path, state.key);
  }

  const flowState = new Map<string, { count: number; examples: Set<string> }>();
  for (const file of allFiles) {
    const importerPath = sourcePath(file);
    const importerFeature = featureByFile.get(importerPath);
    const imports = kg.getImportsWithDetails(file.id);
    for (const imported of imports) {
      const targetPath = imported.resolvedFile ? sourcePath(imported.resolvedFile) : undefined;
      const targetFeature = targetPath ? featureByFile.get(targetPath) : undefined;

      if (!targetFeature) {
        if (importerFeature && isTestPath(importerPath) && targetPath) {
          const testedFeature = featureByFile.get(targetPath);
          if (testedFeature) {
            const state = features.get(testedFeature)!;
            state.testFileSet.add(importerPath);
          }
        }
        continue;
      }

      if (importerFeature && importerFeature !== targetFeature) {
        const importerState = features.get(importerFeature)!;
        const targetState = features.get(targetFeature)!;
        importerState.dependencies.push(targetFeature);
        targetState.dependents.push(importerFeature);
        const flowKey = `${importerFeature}\u0000${targetFeature}`;
        const flow = flowState.get(flowKey) ?? { count: 0, examples: new Set<string>() };
        flow.count++;
        if (flow.examples.size < 5) flow.examples.add(`${importerPath} -> ${targetPath}`);
        flowState.set(flowKey, flow);
      } else if (importerFeature && importerFeature === targetFeature && targetPath) {
        features.get(targetFeature)!.incomingInternal.add(targetPath);
      } else if (!importerFeature && isTestPath(importerPath)) {
        const state = features.get(targetFeature)!;
        state.testFileSet.add(importerPath);
      }
    }
  }

  const ordered = [...features.values()]
    .map((state) => {
      const entries = state.files.filter((file) => !state.incomingInternal.has(file));
      state.entryFiles = entries.length > 0 ? entries : [state.files.slice().sort()[0]];
      state.testFiles = sortUnique(state.testFileSet);
      state.files = sortUnique(state.files);
      state.dependencies = sortUnique(state.dependencies);
      state.dependents = sortUnique(state.dependents);
      return state;
    })
    .sort((a, b) => b.files.length - a.files.length || a.key.localeCompare(b.key));

  const visibleKeys = new Set(ordered.slice(0, safeLimit).map((feature) => feature.key));
  const visibleFeatures = ordered
    .slice(0, safeLimit)
    .map(
      ({ incomingInternal: _incomingInternal, testFileSet: _testFileSet, ...feature }) => feature,
    );
  const flows = [...flowState.entries()]
    .map(([key, flow]) => {
      const [from, to] = key.split('\u0000');
      return { from, to, importCount: flow.count, examples: sortUnique(flow.examples) };
    })
    .filter((flow) => visibleKeys.has(flow.from) && visibleKeys.has(flow.to))
    .sort(
      (a, b) =>
        b.importCount - a.importCount || `${a.from}:${a.to}`.localeCompare(`${b.from}:${b.to}`),
    );

  return {
    generatedAt: new Date().toISOString(),
    totalSourceFiles: sourceFiles.length,
    totalFeatures: ordered.length,
    features: visibleFeatures,
    flows,
    limitations: [
      'Feature labels are deterministic path-derived candidates, not proof of business capabilities.',
      'Unresolved imports and dynamic runtime loading are excluded from flow edges.',
      `Only the top ${safeLimit} feature candidates are returned; totalFeatures reports the complete candidate count.`,
    ],
  };
}
