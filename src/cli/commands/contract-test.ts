import { Command } from 'commander';
import { withService, asyncHandler, output, loadConfig, join } from '@/cli/utils/shared.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { ContractEngine } from '@/index.js';
import fg from 'fast-glob';

export interface ContractTest {
  contractId: string;
  contractName: string;
  contractType: 'layer' | 'forbidden-import' | 'forbidden-keyword' | 'required-import' | 'max-lines' | 'custom';
  testType: 'positive' | 'negative';
  filePath: string;
  expectedResult: 'pass' | 'fail';
  description: string;
  testCode: string;
}

interface ContractLike {
  id: string;
  name: string;
  description?: string;
  sourcePattern: string;
  forbiddenKeywords?: string[];
  forbiddenImports?: string[];
  requiredImports?: string[];
  maxLines?: number;
  severity: 'error' | 'warning';
}

export function createContractTestCommand(): Command {
  const contractTestCmd = new Command('contract-test')
    .description('Generate tests for architectural contracts')
    .option('--generate', 'Generate test file for all contracts')
    .option('--run', 'Run contract tests')
    .option('--framework <fw>', 'Test framework: vitest|jest', 'vitest')
    .option('--output-dir <dir>', 'Output directory for generated tests', 'tests/contracts')
    .option('--format <fmt>', 'Output: text|json', 'text')
    .option('-o, --output <file>', 'Write to file')
    .action(asyncHandler(async (opts: { generate: boolean; run: boolean; framework: string; outputDir: string; format: string; output: string }) => {
      await withService(['scale', 'coherence'], async (_ctx, _services) => {
        const config = loadConfig();
        
        output.section('Contract Test Generator');
        output.kv('Framework', opts.framework);
        output.kv('Output dir', opts.outputDir);
        
        // Get contracts from contract engine
        const contracts = await getContracts(config);
        
        if (contracts.length === 0) {
          output.warn('No contracts found. Configure contracts in .projectmindrc.json');
          return;
        }
        
        output.kv('Contracts found', contracts.length);
        
        const testFiles: { fileName: string; content: string }[] = [];
        
        if (opts.generate) {
          output.section('Generating Contract Tests');
          
          const generated = generateContractTests(contracts, opts.framework, config);
          testFiles.push(...generated);
          
          const outDir = join(config.projectRoot, opts.outputDir);
          if (!existsSync(outDir)) {
            mkdirSync(outDir, { recursive: true });
          }
          
          for (const { fileName, content } of generated) {
            const outputPath = join(outDir, fileName);
            writeFileSync(outputPath, content);
            output.success(`Generated: ${outputPath}`);
          }
          
          output.success(`Generated ${generated.length} test file(s) in ${opts.outputDir}`);
        }
        
        if (opts.run) {
          output.section('Running Contract Tests');
          output.info('Evaluating contracts against source files...');
          
          // Real evaluation: the ContractEngine scans actual project sources
          // for violations of every configured contract.
          const results = runContractEvaluation(config.projectRoot, contracts);
          
          output.kv('Files scanned', results.filesScanned);
          output.kv('Contracts evaluated', results.total);
          output.kv('Passed', results.passed);
          output.kv('Failed', results.failed);
          
          if (results.failed > 0) {
            output.warn('Some contract tests failed');
            for (const failure of results.failures.slice(0, 10)) {
              output.kv(`  ❌ ${failure.contract}`, failure.reason);
            }
          } else {
            output.success('All contract tests passed!');
          }
        }
        
        if (!opts.generate && !opts.run) {
          // List contracts with test suggestions
          output.section('Contract Test Suggestions');
          
          for (const contract of contracts) {
            const tests = suggestContractTests(contract);
            output.kv(`${contract.name} (${contract.id})`, `${tests.length} test(s)`);
            for (const test of tests.slice(0, 3)) {
              output.kv(`  • ${test.description}`, test.type);
            }
          }
        }
        
        if (opts.output) {
          writeFileSync(opts.output, JSON.stringify({ contracts, testFiles: opts.generate ? testFiles.length : 0 }, null, 2));
          output.success(`Written to ${opts.output}`);
        }
      });
    }));
  
  return contractTestCmd;
}

async function getContracts(_config: { projectRoot: string }): Promise<ContractLike[]> {
  // Single source of truth: the ContractEngine loads user contracts from
  // .projectmindrc.json ("contracts" key) or its maintained defaults.
  // A previously duplicated hardcoded list here had drifted out of sync
  // and ignored per-contract excludePaths.
  return new ContractEngine().getContracts() as ContractLike[];
}

function generateContractTests(contracts: ContractLike[], framework: string, _config: { projectRoot: string }): { fileName: string; content: string }[] {
  const testFiles: { fileName: string; content: string }[] = [];
  
  // Group contracts by source pattern
  const byPattern = new Map<string, typeof contracts>();
  for (const contract of contracts) {
    const pattern = contract.sourcePattern;
    if (!byPattern.has(pattern)) byPattern.set(pattern, []);
    byPattern.get(pattern)!.push(contract);
  }
  
  for (const [pattern, patternContracts] of byPattern) {
    const fileName = `contract-${pattern.replace(/[^a-zA-Z0-9]/g, '-')}.test.ts`;
    const content = generateTestFile(patternContracts, pattern, framework);
    testFiles.push({ fileName, content });
  }
  
  return testFiles;
}

function generateTestFile(contracts: ContractLike[], pattern: string, framework: string): string {
  const isVitest = framework === 'vitest';
  const importStmt = isVitest 
    ? `import { describe, it, expect, vi } from 'vitest';`
    : `import { describe, it, expect, vi } from '@jest/globals';`;
  
  const contractTests = contracts.map(contract => {
    const testCases = generateContractTestCases(contract).map(tc => `
  it('${tc.description}', () => {
    const code = \`${tc.testCode}\`;
    const violations = contractEngine.evaluate('${tc.filePath}', code);
    const hasViolation = violations.some(v => v.contractId === '${contract.id}');
    
    if ('${tc.expectedResult}' === 'pass') {
      expect(hasViolation).toBe(false);
    } else {
      expect(hasViolation).toBe(true);
      const violation = violations.find(v => v.contractId === '${contract.id}');
      expect(violation?.severity).toBe('${contract.severity}');
      expect(violation?.message).toContain('${tc.description}');
    }
  }`).join('\n');
    
    return `
describe('${contract.name} (${contract.id})', () => {
${testCases}
});`;
  }).join('\n\n');
  
  return `${importStmt}
// Generated by ProjectMind contract-test.
// Resolves the engine from the installed ProjectMind package — no path
// aliases required, so these tests run in any consumer project.
import { ContractEngine, loadConfig } from '@emirhanturker/projectmind';

const config = loadConfig();
const contractEngine = new ContractEngine(config.contracts);

${contractTests}
`;
}

function generateContractTestCases(contract: ContractLike): { description: string; filePath: string; testCode: string; expectedResult: 'pass' | 'fail' }[] {
  const cases: { description: string; filePath: string; testCode: string; expectedResult: 'pass' | 'fail' }[] = [];
  
  // Negative test cases (should trigger violations)
  if (contract.forbiddenKeywords) {
    for (const kw of contract.forbiddenKeywords) {
      cases.push({
        description: `should detect forbidden keyword "${kw}"`,
        filePath: 'test/file.ts',
        testCode: `const x = ${kw.replace('(', '(')};`,
        expectedResult: 'fail',
      });
    }
  }
  
  if (contract.forbiddenImports) {
    for (const imp of contract.forbiddenImports) {
      cases.push({
        description: `should detect forbidden import "${imp}"`,
        filePath: 'test/file.ts',
        testCode: `import { something } from '${imp}';`,
        expectedResult: 'fail',
      });
    }
  }
  
  if (contract.requiredImports) {
    for (const imp of contract.requiredImports) {
      cases.push({
        description: `should detect missing required import "${imp}"`,
        filePath: 'test/file.ts',
        testCode: `// Missing required import: ${imp}`,
        expectedResult: 'fail',
      });
    }
  }
  
  if (contract.maxLines) {
    cases.push({
      description: `should detect file exceeding ${contract.maxLines} lines`,
      filePath: 'test/large-file.ts',
      testCode: '// '.repeat(contract.maxLines + 10),
      expectedResult: 'fail',
    });
  }
  
  // Positive test cases (should pass)
  cases.push({
    description: `should pass for compliant code`,
    filePath: 'test/compliant.ts',
    testCode: `export function compliant() { return 'ok'; }`,
    expectedResult: 'pass',
  });
  
  return cases;
}

function suggestContractTests(contract: ContractLike): { description: string; type: string }[] {
  const suggestions: { description: string; type: string }[] = [];
  
  if (contract.forbiddenKeywords) {
    for (const kw of contract.forbiddenKeywords) {
      suggestions.push({
        description: `Detect "${kw}" usage`,
        type: 'Negative (should fail)',
      });
    }
  }
  
  if (contract.forbiddenImports) {
    for (const imp of contract.forbiddenImports) {
      suggestions.push({
        description: `Detect forbidden import "${imp}"`,
        type: 'Negative (should fail)',
      });
    }
  }
  
  if (contract.requiredImports) {
    for (const imp of contract.requiredImports) {
      suggestions.push({
        description: `Enforce required import "${imp}"`,
        type: 'Negative (should fail)',
      });
    }
  }
  
  if (contract.maxLines) {
    suggestions.push({
      description: `Enforce max ${contract.maxLines} lines per file`,
      type: 'Negative (should fail)',
    });
  }
  
  suggestions.push({
    description: 'Pass for compliant code',
    type: 'Positive (should pass)',
  });
  
  return suggestions;
}

/**
 * Evaluate every contract against the project's actual source files using
 * ContractEngine. A contract "fails" when at least one matching source file
 * violates it; per-violation details are returned for reporting.
 */
function runContractEvaluation(projectRoot: string, contracts: ContractLike[]): {
  total: number;
  passed: number;
  failed: number;
  filesScanned: number;
  failures: { contract: string; reason: string }[];
} {
  const engine = new ContractEngine(contracts as never);

  const sourceFiles = fg.sync(
    ['**/*.{ts,tsx,js,jsx,mjs,cjs}'],
    {
      cwd: projectRoot,
      ignore: [
        '**/node_modules/**', '**/dist/**', '**/dist-tests/**', '**/.git/**',
        '**/coverage/**', '**/build/**', '**/out/**', '**/.next/**',
        '**/*.min.*', '**/*.d.ts',
      ],
      absolute: false,
    }
  );

  // violations[contractId] = list of human-readable violation descriptions
  const violations = new Map<string, string[]>();
  for (const contract of contracts) {
    violations.set(contract.id, []);
  }

  for (const relPath of sourceFiles) {
    const filePath = join(projectRoot, relPath);
    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    try {
      const found = engine.evaluate(relPath.replace(/\\/g, '/'), content);
      for (const v of found) {
        const list = violations.get(v.contractId);
        if (list) {
          list.push(`${relPath}${v.line ? `:${v.line}` : ''} — ${v.message}`);
        }
      }
    } catch {
      // Unreadable/unparseable file: skip rather than fail the whole run.
    }
  }

  let passed = 0;
  let failed = 0;
  const failures: { contract: string; reason: string }[] = [];

  for (const contract of contracts) {
    const list = violations.get(contract.id) ?? [];
    if (list.length === 0) {
      passed++;
    } else {
      failed++;
      for (const reason of list) {
        failures.push({ contract: contract.name, reason });
      }
    }
  }

  return { total: contracts.length, passed, failed, filesScanned: sourceFiles.length, failures };
}