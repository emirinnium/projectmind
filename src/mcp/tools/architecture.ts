import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from './types.js';

export function registerCheckArchitectureTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'check_architecture',
    {
      title: 'Check Architecture Compliance',
      description: 'Check if a file complies with project architectural patterns and constraints.',
      inputSchema: {
        filePath: z.string().describe('Path of the file to check'),
        strict: z.boolean().default(false).describe('Use strict mode for more thorough checks'),
      },
    },
    async (args) => {
      const file = deps.kg.getFileByPath(args.filePath);
      if (!file) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'File not found in knowledge graph. Run scan_project first.' }) }],
        };
      }

      // Get file details
      const imports = deps.kg.getImportsWithDetails(file.id);
      const functions = deps.kg.getFunctions(file.id);
      const classes = deps.kg.getClasses(file.id);

      // Analyze architecture
      const issues: string[] = [];
      const warnings: string[] = [];
      const suggestions: string[] = [];

      // Check import patterns
      const externalImports = imports.filter((i) => !i.resolvedFile);
      if (externalImports.length > 0) {
        warnings.push(`${externalImports.length} external/unresolved imports detected`);
      }

      // Check for circular imports (actual circular dependency detection)
      const circularCandidates: string[] = [];
      for (const imp of imports) {
        if (imp.resolvedFile) {
          // Check if the resolved file imports back to this file
          const resolvedImports = deps.kg.getImports(imp.resolvedFile.id);
          const hasBackRef = resolvedImports.some((ri) => ri.source.includes(file.relativePath) || file.relativePath.includes(ri.source));
          if (hasBackRef && !circularCandidates.includes(imp.source)) {
            circularCandidates.push(imp.source);
          }
        }
      }
      if (circularCandidates.length > 0) {
        warnings.push(`Potential circular imports: ${circularCandidates.join(', ')}`);
      }

      // Check cognitive load
      if (file.cognitiveLoad > 0.7) {
        issues.push(`High cognitive load (${file.cognitiveLoad.toFixed(2)}). Consider refactoring.`);
      } else if (file.cognitiveLoad > 0.4) {
        warnings.push(`Moderate cognitive load (${file.cognitiveLoad.toFixed(2)})`);
      }

      // Check function complexity
      const complexFunctions = functions.filter(f => (f.complexity ?? 0) > 10);
      if (complexFunctions.length > 0) {
        warnings.push(`${complexFunctions.length} functions with high cyclomatic complexity (>10)`);
      }

      // Check for large files
      if (file.sizeBytes > 50000) {
        warnings.push(`Large file (${(file.sizeBytes / 1024).toFixed(1)} KB). Consider splitting.`);
      }

      // Check agent coverage
      if (!file.agentTouched) {
        suggestions.push('File has not been touched by any agent. Consider reviewing for consistency.');
      }

      // Strict mode checks
      if (args.strict) {
        // Check for TODO/FIXME comments (would need source content)
        suggestions.push('Strict mode: Consider running deep coherence check for detailed analysis');
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              file: file.relativePath,
              compliant: issues.length === 0,
              issues,
              warnings,
              suggestions,
              metrics: {
                cognitiveLoad: file.cognitiveLoad,
                importCount: imports.length,
                functionCount: functions.length,
                classCount: classes.length,
                externalImports: externalImports.length,
                agentTouched: file.agentTouched,
              },
            }, null, 2),
          },
        ],
      };
    }
  );
}

export function registerAnalyzeImpactTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'analyze_impact',
    {
      title: 'Analyze Change Impact',
      description: 'Analyze the impact of changing a file - what other files might be affected.',
      inputSchema: {
        filePath: z.string().describe('Path of the file to analyze'),
        changeType: z.enum(['modify', 'delete', 'rename', 'refactor']).default('modify').describe('Type of change planned'),
      },
    },
    async (args) => {
      const file = deps.kg.getFileByPath(args.filePath);
      if (!file) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'File not found in knowledge graph. Run scan_project first.' }) }],
        };
      }

      // Get direct dependents (high impact = depth 1)
      const allDependents = new Map<number, { file: typeof file; depth: number; path: string[] }>();
      const visited = new Set<number>();

      const traceDependents = (currentFileId: number, depth: number, path: string[]) => {
        if (depth > 5 || visited.has(currentFileId)) return;
        visited.add(currentFileId);

        const deps_ = deps.kg.getDependents(currentFileId);
        for (const dep of deps_) {
          if (!allDependents.has(dep.id)) {
            allDependents.set(dep.id, { file: dep, depth, path: [...path, dep.relativePath] });
            traceDependents(dep.id, depth + 1, [...path, dep.relativePath]);
          }
        }
      };

      traceDependents(file.id, 1, [file.relativePath]);

      // Categorize impact
      const highImpact = Array.from(allDependents.values()).filter((d) => d.depth === 1);
      const mediumImpact = Array.from(allDependents.values()).filter((d) => d.depth === 2);
      const lowImpact = Array.from(allDependents.values()).filter((d) => d.depth > 2);

      // Get imports that might break
      const imports = deps.kg.getImportsWithDetails(file.id);
      const unresolvedImports = imports.filter((i) => !i.resolvedFile);

      let riskLevel = 'low';
      if (highImpact.length > 5 || file.cognitiveLoad > 0.7) riskLevel = 'high';
      else if (highImpact.length > 2 || mediumImpact.length > 5) riskLevel = 'medium';

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              file: file.relativePath,
              changeType: args.changeType,
              riskLevel,
              summary: {
                directDependents: highImpact.length,
                transitiveDependents: allDependents.size,
                unresolvedImports: unresolvedImports.length,
              },
              impact: {
                high: highImpact.map((d) => ({
                  file: d.file.relativePath,
                  cognitiveLoad: d.file.cognitiveLoad,
                  agentTouched: d.file.agentTouched,
                })),
                medium: mediumImpact.map((d) => ({
                  file: d.file.relativePath,
                  depth: d.depth,
                })),
                low: lowImpact.map((d) => ({
                  file: d.file.relativePath,
                  depth: d.depth,
                })),
              },
              recommendations: [
                ...(highImpact.length > 0 ? ['Run tests for all high-impact dependents before merging'] : []),
                ...(unresolvedImports.length > 0 ? ['Verify external dependencies are compatible'] : []),
                ...(args.changeType === 'delete' ? ['Consider deprecation period instead of immediate deletion'] : []),
                ...(args.changeType === 'rename' ? ['Update all import statements in dependent files'] : []),
              ],
            }, null, 2),
          },
        ],
      };
    }
  );
}

export function registerSuggestRefactorTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'suggest_refactor',
    {
      title: 'Suggest Refactoring',
      description: 'Get refactoring suggestions based on code patterns, complexity, and project conventions.',
      inputSchema: {
        filePath: z.string().describe('Path of the file to analyze'),
        focus: z.enum(['complexity', 'duplication', 'architecture', 'performance', 'all']).default('all').describe('Focus area for suggestions'),
      },
    },
    async (args) => {
      const file = deps.kg.getFileByPath(args.filePath);
      if (!file) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'File not found in knowledge graph. Run scan_project first.' }) }],
        };
      }

      const imports = deps.kg.getImportsWithDetails(file.id);
      const functions = deps.kg.getFunctions(file.id);
      const classes = deps.kg.getClasses(file.id);

      const suggestions: { type: string; priority: 'high' | 'medium' | 'low'; message: string; details?: string }[] = [];

      // Complexity-based suggestions
      if (args.focus === 'complexity' || args.focus === 'all') {
        const complexFuncs = functions.filter(f => (f.complexity ?? 0) > 10);
        for (const fn of complexFuncs) {
          suggestions.push({
            type: 'complexity',
            priority: (fn.complexity ?? 0) > 20 ? 'high' : 'medium',
            message: `Function "${fn.name}" has high cyclomatic complexity (${fn.complexity})`,
            details: `Consider extracting logic into smaller functions. File: ${file.relativePath}`,
          });
        }

        if (file.cognitiveLoad > 0.7) {
          suggestions.push({
            type: 'complexity',
            priority: 'high',
            message: `File has very high cognitive load (${file.cognitiveLoad.toFixed(2)})`,
            details: 'Consider splitting this file into multiple smaller modules',
          });
        }
      }

      // Duplication-based suggestions (check for similar functions)
      if (args.focus === 'duplication' || args.focus === 'all') {
        // Check within file
        const funcSignatures = functions.map(f => f.signature);
        const seen = new Set<string>();
        for (const sig of funcSignatures) {
          const simplified = sig?.replace(/\s+/g, ' ').trim() ?? '';
          if (seen.has(simplified)) {
            suggestions.push({
              type: 'duplication',
              priority: 'medium',
              message: `Potential duplicate function signature detected: ${simplified}`,
              details: 'Consider extracting common logic',
            });
          }
          seen.add(simplified);
        }

        // Check across project for similar function signatures
        if (args.focus === 'all' || args.focus === 'duplication') {
          const allFiles = deps.kg.getAllFiles();
          const currentFileFuncs = functions.map(f => ({
            name: f.name,
            signature: f.signature?.replace(/\s+/g, ' ').trim() ?? '',
            file: file.relativePath,
          }));

          for (const otherFile of allFiles) {
            if (otherFile.id === file.id) continue;
            const otherFuncs = deps.kg.getFunctions(otherFile.id);
             for (const otherFn of otherFuncs) {
               const otherSig = otherFn.signature?.replace(/\s+/g, ' ').trim() ?? '';
               for (const currentFn of currentFileFuncs) {
                 if (currentFn.name === otherFn.name && currentFn.signature !== otherSig) {
                   suggestions.push({
                     type: 'duplication',
                     priority: 'low',
                     message: `Function "${currentFn.name}" has similar signature in ${otherFile.relativePath}`,
                     details: `Current: ${currentFn.signature} (${file.relativePath})\nOther: ${otherSig} (${otherFile.relativePath})`,
                   });
                 }
               }
             }
          }
        }
      }

      // Architecture-based suggestions
      if (args.focus === 'architecture' || args.focus === 'all') {
        const externalImports = imports.filter((i) => !i.resolvedFile);
        if (externalImports.length > 10) {
          suggestions.push({
            type: 'architecture',
            priority: 'medium',
            message: `High number of external imports (${externalImports.length})`,
            details: 'Consider creating a facade or barrel export to reduce coupling',
          });
        }

        const deepImports = imports.filter((i) => i.source.includes('../../') || i.source.includes('../'));
        if (deepImports.length > 3) {
          suggestions.push({
            type: 'architecture',
            priority: 'low',
            message: `Many relative imports going up directories (${deepImports.length})`,
            details: 'Consider restructuring module hierarchy or using path aliases',
          });
        }
      }

      // Performance suggestions
      if (args.focus === 'performance' || args.focus === 'all') {
        const largeClasses = classes.filter(c => (c.methodsCount ?? 0) > 15);
        for (const cls of largeClasses) {
          suggestions.push({
            type: 'performance',
            priority: 'medium',
            message: `Class "${cls.name}" has many methods (${cls.methodsCount})`,
            details: 'Consider splitting into smaller classes or using composition',
          });
        }
      }

      // General suggestions based on project patterns
      if (!file.agentTouched) {
        suggestions.push({
          type: 'consistency',
          priority: 'low',
          message: 'File has not been reviewed by AI agents',
          details: 'Consider running coherence check to ensure consistency with project patterns',
        });
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              file: file.relativePath,
              focus: args.focus,
              suggestions: suggestions.sort((a, b) => {
                const priorityOrder = { high: 0, medium: 1, low: 2 };
                return priorityOrder[a.priority] - priorityOrder[b.priority];
              }),
              totalSuggestions: suggestions.length,
            }, null, 2),
          },
        ],
      };
    }
  );
}