import { DatabaseSync } from 'node:sqlite';
import { relative } from 'node:path';
import ts from 'typescript';
import { CoherenceCache } from '../cache/coherence-cache.js';
import { FastCoherenceAnalyzer } from '../coherence/analysis/fast.js';
import { ContractEngine, type ContractViolation } from '../contracts/engine.js';
import { SCHEMA_SQL } from '../../storage/schema.js';

export type PostEditGateStatus = 'pass' | 'warn' | 'fail';

export interface PostEditGateCheck {
  id: 'parse' | 'coherence' | 'impact' | 'typecheck' | 'contract';
  status: PostEditGateStatus;
  details: string[];
}

export interface PostEditGateReport {
  passed: boolean;
  checks: PostEditGateCheck[];
  newTypeErrors: string[];
  newContractErrors: string[];
  publicApiChanged: boolean;
  dependentCount: number;
}

export interface PostEditGateOptions {
  projectRoot: string;
  filePath: string;
  before: string;
  after: string;
  db?: DatabaseSync;
  projectId?: number;
}

/**
 * Run deterministic local safety gates before a source edit is persisted.
 * Existing baseline diagnostics are tolerated; newly introduced failures are
 * not. Warnings remain visible so a human/agent can make an explicit choice.
 */
export function runPostEditGate(options: PostEditGateOptions): PostEditGateReport {
  const relativePath = relative(options.projectRoot, options.filePath).replace(/\\/g, '/');
  const parse = parseCheck(options.projectRoot, options.filePath, options.after);
  const typecheck = typecheckCheck(
    options.projectRoot,
    options.filePath,
    options.before,
    options.after,
  );
  const contract = contractCheck(relativePath, options.before, options.after);
  const coherence = coherenceCheck(relativePath, options.before, options.after);
  const impact = impactCheck(options, relativePath);
  const checks = [parse, coherence, impact, typecheck.check, contract.check];
  return {
    passed: checks.every((check) => check.status !== 'fail'),
    checks,
    newTypeErrors: typecheck.newErrors,
    newContractErrors: contract.newErrors,
    publicApiChanged: impact.publicApiChanged,
    dependentCount: impact.dependentCount,
  };
}

function parseCheck(projectRoot: string, filePath: string, source: string): PostEditGateCheck {
  const diagnostics = collectSyntacticDiagnostics(projectRoot, filePath, source);
  if (diagnostics.length === 0) {
    return { id: 'parse', status: 'pass', details: ['Edited source parses successfully.'] };
  }
  return {
    id: 'parse',
    status: 'fail',
    details: diagnostics.slice(0, 10).map((diagnostic) => formatDiagnostic(diagnostic)),
  };
}

function typecheckCheck(
  projectRoot: string,
  filePath: string,
  before: string,
  after: string,
): { check: PostEditGateCheck; newErrors: string[] } {
  const beforeDiagnostics = collectDiagnostics(projectRoot, filePath, before);
  const afterDiagnostics = collectDiagnostics(projectRoot, filePath, after);
  const beforeCounts = countDiagnosticSignatures(beforeDiagnostics);
  const newErrors: string[] = [];
  for (const diagnostic of afterDiagnostics) {
    const signature = diagnosticSignature(diagnostic);
    const available = beforeCounts.get(signature) ?? 0;
    if (available > 0) {
      beforeCounts.set(signature, available - 1);
    } else {
      newErrors.push(formatDiagnostic(diagnostic));
    }
  }
  return {
    check: {
      id: 'typecheck',
      status: newErrors.length > 0 ? 'fail' : 'pass',
      details:
        newErrors.length > 0
          ? newErrors.slice(0, 10)
          : ['No new TypeScript syntactic or semantic diagnostics were introduced.'],
    },
    newErrors,
  };
}

function collectDiagnostics(
  projectRoot: string,
  filePath: string,
  content: string,
): readonly ts.Diagnostic[] {
  const { program } = createVirtualProgram(projectRoot, filePath, content);
  return [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()];
}

function collectSyntacticDiagnostics(
  projectRoot: string,
  filePath: string,
  content: string,
): readonly ts.Diagnostic[] {
  const { program } = createVirtualProgram(projectRoot, filePath, content);
  return program.getSyntacticDiagnostics();
}

function createVirtualProgram(
  projectRoot: string,
  filePath: string,
  content: string,
): { program: ts.Program; host: ts.CompilerHost } {
  const configFile = ts.findConfigFile(projectRoot, ts.sys.fileExists, 'tsconfig.json');
  let options: ts.CompilerOptions;
  let rootNames: string[] = [filePath];
  if (configFile) {
    const config = ts.readConfigFile(configFile, ts.sys.readFile);
    if (!config.error) {
      const parsed = ts.parseJsonConfigFileContent(
        config.config,
        ts.sys,
        projectRoot,
        undefined,
        configFile,
      );
      options = {
        ...parsed.options,
        allowJs: parsed.options.allowJs ?? true,
        noEmit: true,
        skipLibCheck: parsed.options.skipLibCheck ?? true,
      };
      rootNames = parsed.fileNames.includes(filePath)
        ? parsed.fileNames
        : [...parsed.fileNames, filePath];
    } else {
      options = defaultTypecheckOptions();
    }
  } else {
    options = defaultTypecheckOptions();
  }
  const host = ts.createCompilerHost(options, true);
  const normalizedTarget = normalizeFileName(filePath);
  const originalReadFile = host.readFile.bind(host);
  const originalFileExists = host.fileExists.bind(host);
  host.readFile = (candidate) =>
    normalizeFileName(candidate) === normalizedTarget ? content : originalReadFile(candidate);
  host.fileExists = (candidate) =>
    normalizeFileName(candidate) === normalizedTarget || originalFileExists(candidate);
  const program = ts.createProgram(rootNames, options, host);
  return { program, host };
}

function defaultTypecheckOptions(): ts.CompilerOptions {
  return {
    allowJs: true,
    checkJs: false,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  };
}

function contractCheck(
  relativePath: string,
  before: string,
  after: string,
): { check: PostEditGateCheck; newErrors: string[] } {
  const engine = new ContractEngine();
  const beforeViolations = engine.evaluate(relativePath, before);
  const afterViolations = engine.evaluate(relativePath, after);
  const beforeCounts = countContractSignatures(
    beforeViolations.filter((v) => v.severity === 'error'),
  );
  const newErrors: string[] = [];
  for (const violation of afterViolations.filter((v) => v.severity === 'error')) {
    const signature = contractSignature(violation);
    const available = beforeCounts.get(signature) ?? 0;
    if (available > 0) beforeCounts.set(signature, available - 1);
    else newErrors.push(formatContractViolation(violation));
  }
  const warnings = afterViolations.filter((v) => v.severity === 'warning');
  return {
    check: {
      id: 'contract',
      status: newErrors.length > 0 ? 'fail' : warnings.length > 0 ? 'warn' : 'pass',
      details:
        newErrors.length > 0
          ? newErrors.slice(0, 10)
          : warnings.length > 0
            ? warnings.slice(0, 10).map(formatContractViolation)
            : ['No new architectural contract errors were introduced.'],
    },
    newErrors,
  };
}

function coherenceCheck(filePath: string, before: string, after: string): PostEditGateCheck {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(SCHEMA_SQL);
    const analyzer = new FastCoherenceAnalyzer(db, new CoherenceCache(100, 60_000));
    const beforeResult = analyzer.analyze(
      { code: before, filePath, fastOnly: true },
      `before-${filePath}`,
    );
    const afterResult = analyzer.analyze(
      { code: after, filePath, fastOnly: true },
      `after-${filePath}`,
    );
    const beforeRank = verdictRank(beforeResult.verdict);
    const afterRank = verdictRank(afterResult.verdict);
    const newSuggestions = afterResult.suggestions.filter(
      (suggestion) => !beforeResult.suggestions.includes(suggestion),
    );
    if (afterRank > beforeRank) {
      return {
        id: 'coherence',
        status: 'fail',
        details: [
          `Coherence changed from ${beforeResult.verdict} to ${afterResult.verdict}.`,
          ...newSuggestions.slice(0, 10),
        ],
      };
    }
    return {
      id: 'coherence',
      status: newSuggestions.length > 0 ? 'warn' : 'pass',
      details: [
        `Coherence remained at ${afterResult.verdict}; no regression was detected.`,
        ...newSuggestions.slice(0, 10),
      ],
    };
  } finally {
    db.close();
  }
}

function impactCheck(
  options: PostEditGateOptions,
  relativePath: string,
): PostEditGateCheck & { publicApiChanged: boolean; dependentCount: number } {
  const beforeApi = publicApi(options.filePath, options.before);
  const afterApi = publicApi(options.filePath, options.after);
  const publicApiChanged = JSON.stringify(beforeApi) !== JSON.stringify(afterApi);
  let dependentCount = 0;
  if (options.db && options.projectId !== undefined) {
    dependentCount = Number(
      (
        options.db
          .prepare(
            `SELECT COUNT(DISTINCT i.file_id) AS count
             FROM imports i
             JOIN files f ON f.id = i.file_id
             WHERE f.project_id = ? AND i.resolved_path = ?`,
          )
          .get(options.projectId, relativePath) as { count: number }
      ).count,
    );
  }
  if (!publicApiChanged) {
    return {
      id: 'impact',
      status: 'pass',
      details: ['No exported declaration or import surface changed.'],
      publicApiChanged,
      dependentCount,
    };
  }
  return {
    id: 'impact',
    status: 'warn',
    details: [
      `Public API changed in ${relativePath}.`,
      `${dependentCount} indexed dependent file(s) may require review.`,
      'Run impact analysis and typecheck before accepting the edit.',
    ],
    publicApiChanged,
    dependentCount,
  };
}

function publicApi(filePath: string, source: string): string[] {
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(filePath),
  );
  const entries: string[] = [];
  for (const statement of sourceFile.statements) {
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    const exported = modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (exported && 'name' in statement) {
      const name = (statement as unknown as ts.NamedDeclaration).name;
      if (name && !ts.isComputedPropertyName(name))
        entries.push(`decl:${name.getText(sourceFile)}`);
    }
    if (ts.isExportDeclaration(statement)) {
      entries.push(`export:${statement.getText(sourceFile)}`);
    }
  }
  return entries.sort();
}

function scriptKindFor(filePath: string): ts.ScriptKind {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (lower.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs'))
    return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function verdictRank(verdict: 'pass' | 'warn' | 'fail'): number {
  return verdict === 'fail' ? 2 : verdict === 'warn' ? 1 : 0;
}

function normalizeFileName(filePath: string): string {
  return filePath.replace(/\\/g, '/').toLowerCase();
}

function diagnosticSignature(diagnostic: ts.Diagnostic): string {
  return `${diagnostic.code}:${flattenMessage(diagnostic.messageText)}`;
}

function countDiagnosticSignatures(diagnostics: readonly ts.Diagnostic[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const diagnostic of diagnostics) {
    const signature = diagnosticSignature(diagnostic);
    counts.set(signature, (counts.get(signature) ?? 0) + 1);
  }
  return counts;
}

function contractSignature(violation: ContractViolation): string {
  return `${violation.contractId}:${violation.message}`;
}

function countContractSignatures(violations: readonly ContractViolation[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const violation of violations) {
    const signature = contractSignature(violation);
    counts.set(signature, (counts.get(signature) ?? 0) + 1);
  }
  return counts;
}

function flattenMessage(message: string | ts.DiagnosticMessageChain): string {
  return ts.flattenDiagnosticMessageText(message, ' ');
}

function formatDiagnostic(diagnostic: ts.Diagnostic): string {
  const location = diagnostic.start === undefined ? '' : ` at offset ${diagnostic.start}`;
  return `TS${diagnostic.code}${location}: ${flattenMessage(diagnostic.messageText)}`;
}

function formatContractViolation(violation: ContractViolation): string {
  return `${violation.contractName}${violation.line ? ` at line ${violation.line}` : ''}: ${violation.message}`;
}
