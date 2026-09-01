import { Command } from 'commander';
import { withService, asyncHandler, output, logger } from '@/cli/utils/shared.js';
import { writeFileSync, readFileSync } from 'node:fs';

interface Layer {
  name: string;
  pattern: string;
  order: number;
  description: string;
}

interface LayerViolation {
  file: string;
  layer: string;
  importsFrom: string[];
  violatedLayers: string[];
  severity: 'error' | 'warning';
}

const DEFAULT_LAYERS: Layer[] = [
  {
    name: 'domain',
    pattern: 'src/domain/**',
    order: 1,
    description: 'Enterprise business logic, entities, value objects',
  },
  {
    name: 'application',
    pattern: 'src/application/**',
    order: 2,
    description: 'Use cases, application services, DTOs',
  },
  {
    name: 'infrastructure',
    pattern: 'src/infrastructure/**',
    order: 3,
    description: 'Database, external APIs, frameworks, UI',
  },
  {
    name: 'presentation',
    pattern: 'src/presentation/**',
    order: 4,
    description: 'Controllers, presenters, view models',
  },
  {
    name: 'shared',
    pattern: 'src/shared/**',
    order: 0,
    description: 'Shared utilities, common types, cross-cutting concerns',
  },
];

export function createLayersCommand(): Command {
  const layersCmd = new Command('layers')
    .description('Enforce architectural layer boundaries')
    .option(
      '--define <layers>',
      'Comma-separated layer definitions (name:pattern:order:description)',
    )
    .option('--config <file>', 'Layer config JSON file')
    .option('--format <fmt>', 'Output: text|json|mermaid', 'text')
    .option('-o, --output <file>', 'Write to file')
    .option('--auto-fix', 'Suggest fixes for violations')
    .action(
      asyncHandler(
        async (opts: {
          define: string;
          config: string;
          format: string;
          output: string;
          autoFix: boolean;
        }) => {
          await withService(['scale'], async (_ctx, services) => {
            const scale = services.scale!;

            output.section('Layer Boundary Enforcement');

            const report = scale.getScaleReport();
            const allFiles = report.modules.flatMap((m) => m.files || []);

            // Parse layer configuration
            let layers: Layer[] = DEFAULT_LAYERS;

            if (opts.config) {
              const configContent = readFileSync(opts.config, 'utf-8');
              layers = JSON.parse(configContent).layers;
            } else if (opts.define) {
              layers = parseLayerDefinitions(opts.define);
            }

            // Sort layers by order
            layers.sort((a, b) => a.order - b.order);

            output.kv('Layers defined', layers.length);
            for (const layer of layers) {
              output.kv(`  ${layer.order}. ${layer.name}`, layer.pattern);
            }

            // Analyze files
            const violations: LayerViolation[] = [];
            const fileLayers = new Map<string, string>();

            // Assign each file to a layer
            for (const file of allFiles) {
              if (file.language !== 'typescript') continue;
              for (const layer of layers) {
                if (matchPattern(file.relativePath, layer.pattern)) {
                  fileLayers.set(file.path, layer.name);
                  break;
                }
              }
            }

            // Check imports for violations
            for (const file of allFiles) {
              if (file.language !== 'typescript') continue;
              const fileLayer = fileLayers.get(file.path);
              if (!fileLayer) continue; // File not in any layer

              const fileLayerOrder = layers.find((l) => l.name === fileLayer)?.order ?? 999;

              try {
                const content = readFileSync(file.path, 'utf-8');
                const imports = extractImports(content);

                for (const imp of imports) {
                  // Find which layer the imported module belongs to
                  const importedLayer = findLayerForImport(imp.source, fileLayers);
                  if (!importedLayer) continue; // External or unknown

                  const importedLayerOrder =
                    layers.find((l) => l.name === importedLayer)?.order ?? 999;

                  // Check for violation: importing from higher layer (wrong direction)
                  // In Clean Architecture, inner layers should not depend on outer layers
                  // So a layer should only import from same or lower order layers
                  if (importedLayerOrder > fileLayerOrder) {
                    violations.push({
                      file: file.relativePath,
                      layer: fileLayer,
                      importsFrom: [imp.source],
                      violatedLayers: [importedLayer],
                      severity: importedLayerOrder - fileLayerOrder > 1 ? 'error' : 'warning',
                    });
                  }
                }
              } catch {
                logger.warn(`Skipping unreadable file in layer analysis: ${file.path}`);
              }
            }

            // Group violations by file
            const violationsByFile = new Map<string, LayerViolation[]>();
            for (const v of violations) {
              const existing = violationsByFile.get(v.file) || [];
              existing.push(v);
              violationsByFile.set(v.file, existing);
            }

            // Merge violations for same file
            const mergedViolations: LayerViolation[] = [];
            for (const [file, viols] of violationsByFile) {
              mergedViolations.push({
                file,
                layer: viols[0].layer,
                importsFrom: viols.flatMap((v) => v.importsFrom),
                violatedLayers: [...new Set(viols.flatMap((v) => v.violatedLayers))],
                severity: viols.some((v) => v.severity === 'error') ? 'error' : 'warning',
              });
            }

            if (opts.format === 'json') {
              const result = {
                layers,
                violations: mergedViolations,
                summary: {
                  totalFiles: allFiles.length,
                  violations: mergedViolations.length,
                  errors: mergedViolations.filter((v) => v.severity === 'error').length,
                  warnings: mergedViolations.filter((v) => v.severity === 'warning').length,
                },
              };
              const content = JSON.stringify(result, null, 2);
              if (opts.output) {
                writeFileSync(opts.output, content);
                output.success(`Written to ${opts.output}`);
              } else {
                console.log(content);
              }
              return;
            }

            if (opts.format === 'mermaid') {
              const content = generateMermaidLayers(DEFAULT_LAYERS, mergedViolations);
              if (opts.output) {
                writeFileSync(opts.output, content);
                output.success(`Written to ${opts.output}`);
              } else {
                console.log(content);
              }
              return;
            }

            // Text format
            if (mergedViolations.length === 0) {
              output.success('No layer boundary violations found!');
            } else {
              output.section(`Layer Violations (${mergedViolations.length})`);

              const errors = mergedViolations.filter((v) => v.severity === 'error');
              const warnings = mergedViolations.filter((v) => v.severity === 'warning');

              if (errors.length > 0) {
                output.section(`Errors (${errors.length})`);
                for (const v of errors) {
                  output.kv(
                    `  🔴 ${v.file} (${v.layer})`,
                    `Imports from: ${v.violatedLayers.join(', ')}`,
                  );
                  for (const imp of v.importsFrom) {
                    output.kv(`    → ${imp}`, '');
                  }
                }
              }

              if (warnings.length > 0) {
                output.section(`Warnings (${warnings.length})`);
                for (const v of warnings.slice(0, 20)) {
                  output.kv(
                    `  🟡 ${v.file} (${v.layer})`,
                    `Imports from: ${v.violatedLayers.join(', ')}`,
                  );
                  for (const imp of v.importsFrom.slice(0, 3)) {
                    output.kv(`    → ${imp}`, '');
                  }
                  if (v.importsFrom.length > 3) {
                    output.kv(`    → ... and ${v.importsFrom.length - 3} more`, '');
                  }
                }
              }

              if (opts.autoFix) {
                output.section('Auto-fix Suggestions');
                for (const v of mergedViolations.slice(0, 10)) {
                  output.kv(
                    `  ${v.file}`,
                    `Consider moving to ${v.violatedLayers[0]} layer or using dependency inversion`,
                  );
                }
              }
            }

            output.section('Summary');
            output.kv('Total TS files', allFiles.filter((f) => f.language === 'typescript').length);
            output.kv('Files with violations', violationsByFile.size);
            output.kv('Errors', mergedViolations.filter((v) => v.severity === 'error').length);
            output.kv('Warnings', mergedViolations.filter((v) => v.severity === 'warning').length);

            if (opts.output) {
              const result = { layers, violations: mergedViolations };
              writeFileSync(opts.output, JSON.stringify(result, null, 2));
              output.success(`Written to ${opts.output}`);
            }
          });
        },
      ),
    );

  return layersCmd;
}

function parseLayerDefinitions(def: string): Layer[] {
  // Format: name:pattern:order:description,name:pattern:order:description
  return def.split(',').map((part, i) => {
    const [name, pattern, order, description] = part.split(':');
    return {
      name: name.trim(),
      pattern: pattern.trim(),
      order: parseInt(order.trim()) || i,
      description: description?.trim() || '',
    };
  });
}

function matchPattern(filePath: string, pattern: string): boolean {
  // Convert glob pattern to regex
  const regexPattern = pattern.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\?/g, '.');
  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(filePath);
}

function extractImports(content: string): { source: string; named: string[] }[] {
  const imports: { source: string; named: string[] }[] = [];
  const importRegex =
    /^\s*import\s+(?:(?:\*|[^{}\n]+)\s+as\s+)?(?:\w+(?:\s*,\s*\w+)*)?(?:\s*{\s*([^}]+)\s*})?\s+from\s+['"]([^'"]+)['"]/gm;
  let match;
  while ((match = importRegex.exec(content)) !== null) {
    imports.push({
      source: match[2],
      named: match[1] ? match[1].split(',').map((s) => s.trim()) : [],
    });
  }
  return imports;
}

function findLayerForImport(importSource: string, fileLayers: Map<string, string>): string | null {
  // Skip external imports (not relative or alias-based)
  if (!importSource.startsWith('.') && !importSource.startsWith('@/')) {
    return null;
  }

  // For @/ aliases, check if any file matches the pattern
  if (importSource.startsWith('@/')) {
    const importPath = importSource.replace('@/', '');
    for (const [filePath, layer] of fileLayers) {
      if (filePath.includes(importPath)) {
        return layer;
      }
    }
  }

  // For relative imports, try to resolve based on common parent directories
  if (importSource.startsWith('..')) {
    // Relative parent imports are typically cross-layer
    for (const [filePath, layer] of fileLayers) {
      const parts = filePath.split('/');
      if (parts.length > 1 && importSource.includes(parts[0])) {
        return layer;
      }
    }
  }

  return null;
}

function generateMermaidLayers(layers: Layer[], violations: LayerViolation[]): string {
  const lines = ['graph TD'];

  // Add layer nodes
  for (const layer of layers) {
    const id = layer.name;
    lines.push(`  ${id}["${layer.name} (${layer.order})"]`);
    lines.push(`  style ${id} fill:#e8f5e9`);
  }

  // Add layer ordering edges
  for (let i = 0; i < layers.length - 1; i++) {
    lines.push(`  ${layers[i].name} --> ${layers[i + 1].name}`);
  }

  // Add violation edges
  for (const v of violations) {
    for (const violated of v.violatedLayers) {
      if (v.layer !== violated) {
        lines.push(`  ${v.layer} -.->|VIOLATION| ${violated}`);
      }
    }
  }

  lines.push('  style default fill:#ffebee,stroke:#c62828');

  return lines.join('\n');
}
