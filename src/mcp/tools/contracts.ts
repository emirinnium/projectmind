import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { relative } from 'node:path';
import fg from 'fast-glob';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from './types.js';
import { ContractEngine } from '@/core/contracts/engine.js';
import type { ContractViolation } from '@/core/contracts/engine.js';
import { confineToProject } from './_shared.js';

/** Real severity domain of the ContractEngine violations. */
export type ContractSeverity = 'error' | 'warning';

/** Input accepted by the check_contracts tool. */
export interface CheckContractsArgs {
  filePath?: string;
  scope?: 'file' | 'project';
  severityFilter?: ContractSeverity | 'all';
}

/** A single contract violation, enriched with the file it was found in. */
export interface ContractViolationResult {
  contractId: string;
  contractName: string;
  file: string;
  line?: number;
  severity: ContractSeverity;
  message: string;
}

/** Result of a contract evaluation run — mirrors contract-test --run. */
export interface CheckContractsResult {
  violations: ContractViolationResult[];
  /** Contracts with zero violations. */
  passed: number;
  /** Contracts with at least one violation. */
  failed: number;
  /** Total contracts evaluated. */
  total: number;
  /** Number of source files scanned. */
  filesScanned: number;
}

/** Glob patterns + ignores used to enumerate project source files (same as the CLI). */
const SOURCE_GLOBS = ['**/*.{ts,tsx,js,jsx,mjs,cjs}'];
const SOURCE_IGNORES = [
  '**/node_modules/**',
  '**/dist/**',
  '**/dist-tests/**',
  '**/.git/**',
  '**/coverage/**',
  '**/build/**',
  '**/out/**',
  '**/.next/**',
  '**/*.min.*',
  '**/*.d.ts',
];

/**
 * Evaluate the project's architectural contracts against a single file or the
 * whole project. Pure and dependency-light so it is directly unit-testable
 * (mirrors the cli-bridge pattern of exporting the core logic for tests).
 *
 * - `filePath` (or `scope: 'file'`): evaluate just that one file.
 * - `scope: 'project'` (or no filePath): scan all project source files and
 *   evaluate each.
 *
 * `severityFilter` narrows the returned violations to the requested severity
 * (or 'all' for no filtering). `passed`/`failed` count contracts, matching
 * `contract-test --run`.
 */
export async function evaluateContracts(
  deps: McpDependencies,
  args: CheckContractsArgs
): Promise<CheckContractsResult> {
  const engine = new ContractEngine();
  const contracts = engine.getContracts();
  const severityFilter = args.severityFilter ?? 'all';

  const files: { absPath: string; relPath: string }[] = [];

  if (args.filePath || args.scope === 'file') {
    const target = args.filePath ?? '';
    if (!target) {
      throw new Error('filePath is required when scope is "file"');
    }
    const absPath = confineToProject(target, deps.projectRoot);
    files.push({ absPath, relPath: relative(deps.projectRoot, absPath).replace(/\\/g, '/') });
  } else {
    // scope 'project' (or default): scan the whole project.
    const matches = fg.sync(SOURCE_GLOBS, {
      cwd: deps.projectRoot,
      ignore: SOURCE_IGNORES,
      absolute: false,
    });
    for (const relPath of matches) {
      files.push({ absPath: confineToProject(relPath, deps.projectRoot), relPath });
    }
  }

  const violations: ContractViolationResult[] = [];

  for (const { absPath, relPath } of files) {
    let content: string;
    try {
      content = await readFile(absPath, 'utf-8');
    } catch {
      // Unreadable file — skip rather than fail the whole run.
      continue;
    }

    let found: ContractViolation[];
    try {
      found = engine.evaluate(relPath, content);
    } catch {
      // Unparseable content — skip.
      continue;
    }

    for (const v of found) {
      if (severityFilter !== 'all' && v.severity !== severityFilter) continue;
      violations.push({
        contractId: v.contractId,
        contractName: v.contractName,
        file: relPath,
        line: v.line,
        severity: v.severity,
        message: v.message,
      });
    }
  }

  // Count contracts that passed/failed (a contract fails when it has ≥1
  // violation), matching contract-test --run semantics.
  const failedContractIds = new Set(violations.map((v) => v.contractId));
  const failed = failedContractIds.size;
  const passed = contracts.length - failed;

  return {
    violations,
    passed,
    failed,
    total: contracts.length,
    filesScanned: files.length,
  };
}

export function registerCheckContractsTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'check_contracts',
    {
      title: 'Check Architectural Contracts',
      description:
        'Enforce the project\'s architectural contracts on a single file or the whole repo and return file:line violations. ' +
        'Runs the ContractEngine over matching source files and reports violations with their severity.',
      inputSchema: {
        filePath: z.string().optional().describe('Path of a single file to check (relative to project root or absolute in-project)'),
        scope: z.enum(['file', 'project']).optional().describe('"file" checks a single filePath; "project" scans the whole repo (default when no filePath given)'),
        severityFilter: z.enum(['error', 'warning', 'all']).optional().describe('Only return violations of this severity (default "all")'),
      },
    },
    async (args) => {
      try {
        const result = await evaluateContracts(deps, {
          filePath: args.filePath,
          scope: args.scope,
          severityFilter: args.severityFilter,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
        };
      }
    }
  );
}
