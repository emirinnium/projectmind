import { loadConfig } from '../../utils/config.js';
import type { ProjectMindConfig } from '../../utils/config.js';

export interface ArchitecturalContract {
  id: string;
  name: string;
  description?: string;
  sourcePattern: string;
  forbiddenImports?: string[];
  /** Code keywords/patterns forbidden. Supports both literal strings and regex patterns (e.g., "\\bany\\b", dynamic execution patterns) */
  forbiddenKeywords?: string[];
  requiredImports?: string[];
  maxLines?: number;
  severity: 'error' | 'warning';
  /** Glob patterns of files this contract must NOT be applied to.
   *  Useful for exempting rule-definition files from their own rules
   *  (e.g. the contracts engine listing "process.exit(" as literal data). */
  excludePaths?: string[];
}

export interface ContractViolation {
  contractId: string;
  contractName: string;
  severity: 'error' | 'warning';
  message: string;
  line?: number;
}

export class ContractEngine {
  private contracts: ArchitecturalContract[];

  constructor(contracts?: ArchitecturalContract[]) {
    if (contracts && contracts.length > 0) {
      this.contracts = contracts;
    } else {
      const config = loadConfig() as ProjectMindConfig & { contracts?: ArchitecturalContract[] };
      this.contracts = config.contracts || this.getDefaultContracts();
    }
  }

  getDefaultContracts(): ArchitecturalContract[] {
    return [
      {
        id: 'no-eval',
        name: 'No Dynamic Execution (eval)',
        description: 'Dynamic code execution (eval/Function constructor) is strictly prohibited for security',
        sourcePattern: '**/*.ts',
        forbiddenKeywords: ['eval\\s*\\(', 'new\\s+Function\\s*\\('],
        severity: 'error',
      },
      {
        id: 'no-raw-process-exit-in-core',
        name: 'No Unhandled Process Exit in Core',
        description: 'Core modules should throw errors rather than calling process.exit directly',
        sourcePattern: 'src/core/**/*.ts',
        forbiddenKeywords: ['process.exit('],
        severity: 'error',
        // The engine itself lists the keyword as literal DATA, not code.
        excludePaths: ['src/core/contracts/engine.ts'],
      },
      {
        id: 'no-direct-db-in-mcp-tools',
        name: 'No Direct DB Schema Modification in Tools',
        description: 'MCP tools must use KnowledgeGraph or abstraction layer rather than direct SQL DDL',
        sourcePattern: 'src/mcp/tools/**/*.ts',
        forbiddenKeywords: ['CREATE TABLE', 'DROP TABLE', 'ALTER TABLE'],
        severity: 'warning',
      },
      // NEW: Added contracts for Step B finalization
      {
        id: 'no-inline-any-in-cli',
        name: 'No inline "any" in CLI Commands',
        description: 'CLI command files should avoid using "any" type for type safety',
        sourcePattern: 'src/cli/commands/**/*.ts',
        forbiddenKeywords: ['\\bany\\b'],
        severity: 'error',
      },
      {
        id: 'no-hardcoded-paths-in-tools',
        name: 'No Hardcoded File Paths in Tools',
        description: 'MCP tools should use KnowledgeGraph path resolution rather than hardcoded paths',
        sourcePattern: 'src/mcp/tools/**/*.ts',
        forbiddenKeywords: ['\\.\\./\\.\\./src/storage'],
        severity: 'warning',
      },
      {
        id: 'no-unused-imports-in-critical',
        name: 'No Unused Imports in Critical Files',
        description: 'Critical files should not have imports that are never used',
        sourcePattern: 'src/core/**/*.ts',
        forbiddenImports: ['src/cli/'],
        severity: 'error',
      },
    ];
  }

  addContract(contract: ArchitecturalContract): void {
    this.contracts.push(contract);
  }

  getContracts(): ArchitecturalContract[] {
    return this.contracts;
  }

  evaluate(filePath: string, code: string): ContractViolation[] {
    const violations: ContractViolation[] = [];
    const normalizedPath = filePath.replace(/\\/g, '/');

    for (const contract of this.contracts) {
      if (!this.matchesPattern(normalizedPath, contract.sourcePattern)) {
        continue;
      }

      // Honor per-contract path exclusions.
      if (contract.excludePaths?.some((ex) => this.matchesPattern(normalizedPath, ex))) {
        continue;
      }

      // 1. Check forbidden keywords (supports both literal strings and regex patterns)
      if (contract.forbiddenKeywords) {
        for (const kw of contract.forbiddenKeywords) {
          const lines = code.split(/\r?\n/);
          const regex = ContractEngine.tryParseRegex(kw);
          lines.forEach((lineText, idx) => {
            const matches = regex ? regex.test(lineText) : lineText.includes(kw);
            if (matches) {
              violations.push({
                contractId: contract.id,
                contractName: contract.name,
                severity: contract.severity,
                message: `Forbidden keyword/pattern "${kw}" found: "${lineText.trim()}"`,
                line: idx + 1,
              });
            }
          });
        }
      }

      // 2. Check forbidden imports
      if (contract.forbiddenImports) {
        const importRegex = /^\s*import\s+.*?from\s+['"]([^'"]+)['"]/gm;
        let match;
        while ((match = importRegex.exec(code)) !== null) {
          const importedSource = match[1];
          for (const forbidden of contract.forbiddenImports) {
            if (importedSource.includes(forbidden) || this.matchesPattern(importedSource, forbidden)) {
              violations.push({
                contractId: contract.id,
                contractName: contract.name,
                severity: contract.severity,
                message: `Forbidden import "${importedSource}" matched rule "${forbidden}"`,
              });
            }
          }
        }
      }

      // 3. Check required imports
      if (contract.requiredImports) {
        for (const req of contract.requiredImports) {
          if (!code.includes(req)) {
            violations.push({
              contractId: contract.id,
              contractName: contract.name,
              severity: contract.severity,
              message: `Required import/pattern "${req}" is missing`,
            });
          }
        }
      }

      // 4. Check max lines
      if (contract.maxLines) {
        const lineCount = code.split(/\r?\n/).length;
        if (lineCount > contract.maxLines) {
          violations.push({
            contractId: contract.id,
            contractName: contract.name,
            severity: contract.severity,
            message: `File line count (${lineCount}) exceeds maximum allowed (${contract.maxLines})`,
          });
        }
      }
    }

    return violations;
  }

  private matchesPattern(path: string, pattern: string): boolean {
    // Exact match
    if (path === pattern) return true;
    
    // Wildcard - matches everything
    if (pattern === '*' || pattern === '**/*.ts') return true;
    
    // Convert glob pattern to regex
    // Handle patterns like "src/core/**/*.ts" or "src/cli/commands/**/*.ts"
    const regexPattern = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape special regex chars except * and ?
      .replace(/\*\*/g, '.*')               // ** matches any path segments (including none)
      .replace(/\*/g, '[^/]*');             // * matches anything except path separator
    
    try {
      const regex = new RegExp(`^${regexPattern}$`, 'i');
      return regex.test(path);
    } catch {
      // Fallback to simple includes if regex fails
      const cleanPattern = pattern.replace(/^\*\*\//, '').replace(/\/\*\*\/\*$/, '').replace(/\*$/, '');
      return path.includes(cleanPattern);
    }
  }

  /**
   * Try to parse a string as a regex pattern. Returns null if it should be treated as a literal string.
   * A pattern is treated as regex if it contains regex-specific characters like \, [], {}, $, ^, etc.
   */
  private static tryParseRegex(pattern: string): RegExp | null {
    // Check if the pattern looks like a regex (contains special regex characters)
    const regexIndicators = /[\\\[\](){}^$+*?|]/;
    if (!regexIndicators.test(pattern)) {
      return null; // Treat as literal string
    }
    try {
      return new RegExp(pattern, 'i');
    } catch {
      return null; // Invalid regex, fall back to literal string matching
    }
  }
}
