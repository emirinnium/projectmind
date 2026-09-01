import { DatabaseSync } from 'node:sqlite';
import type {
  CodeChange,
  ImpactReport,
  ActualImpact,
  PredictorConfig,
  PredictedFailure,
} from './types.js';
import ts from 'typescript';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'node:child_process';
import { computeRiskLevel } from './risk-levels.js';

// Note on git history reliability (Question 6):
// `git log --follow` is reliable for simple renames but has edge cases with
// submodules (submodule paths don't follow parent repo history) and monorepos
// (multiple packages with same relative paths). For monorepos, prefer
// `git rev-list --objects --all -- <path>` as a more robust alternative.

export class ImpactPredictor {
  private config: PredictorConfig;
  private modelWeights: Map<string, number> = new Map();
  private outcomes: ActualImpact[] = [];
  private db?: DatabaseSync;

  constructor(config: PredictorConfig, db?: DatabaseSync) {
    this.config = config;
    this.db = db;
    this.modelWeights.set('crossModule', config.crossModuleWeight);
    this.modelWeights.set('prior', config.bayesianPrior);
  }

  private generatePreviousContent(change: CodeChange, _current: string): string {
    if (change.previousContent !== undefined) return change.previousContent;
    if (change.diffText !== undefined) return change.diffText;
    try {
      const gitPath = change.filePath.replace(/\\/g, '/');
      // Security hardening: reject paths that could be used for injection or
      // traversal outside the repo. execFileSync with an argument array is
      // already safe against shell metacharacters, but we additionally block
      // null bytes and `..` segments that would escape the working tree.
      if (gitPath.includes('\0')) {
        return '';
      }
      if (gitPath.split('/').includes('..')) {
        return '';
      }
      // execFileSync with an argument array — filePath is user-controlled
      // (reachable via the predict_impact MCP tool) and must never be
      // interpolated into a shell command string. stderr is ignored so a
      // file not present in HEAD cannot leak `fatal: path ... does not
      // exist in 'HEAD'` into the MCP stdio stream (integrity-guard pattern).
      return execFileSync('git', ['show', `HEAD:${gitPath}`], {
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      // Treat as new file if no git info
      return '';
    }
  }

  private findNodeByName<T extends ts.Node>(
    source: ts.SourceFile,
    name: string,
    predicate: (n: ts.Node) => n is T,
  ): T | undefined {
    let result: T | undefined;
    const visit = (node: ts.Node) => {
      if (result) return;
      if (predicate(node)) {
        const n = node as T;
        if (
          'name' in n &&
          n.name &&
          ts.isIdentifier(n.name as ts.Node) &&
          (n.name as ts.Identifier).text === name
        ) {
          result = n;
          return;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return result;
  }

  private signatureFromNode(node: ts.FunctionDeclaration, source: ts.SourceFile): string {
    const params = node.parameters.map((p) => p.getText(source)).join(', ');
    const ret = node.type ? node.type.getText(source) : 'void';
    return `(${params}): ${ret}`;
  }

  simulateDiff(change: CodeChange): {
    changedFunctions: Array<{ name: string; oldSig: string; newSig: string }>;
    changedTypes: Array<{ name: string; oldDef: string; newDef: string }>;
  } {
    let currentContent = '';
    try {
      currentContent = fs.readFileSync(change.filePath, 'utf-8');
    } catch {
      currentContent = '';
    }

    const prevContent =
      change.previousContent ??
      change.diffText ??
      this.generatePreviousContent(change, currentContent);
    const tmpDir = os.tmpdir();
    const prevPath = path.join(
      tmpDir,
      `prev-${Date.now()}-${Math.random().toString(36).slice(2)}.ts`,
    );
    fs.writeFileSync(prevPath, prevContent, 'utf-8');

    try {
      const program = ts.createProgram([change.filePath, prevPath], {
        noEmit: true,
        skipLibCheck: true,
        target: ts.ScriptTarget.Latest,
        module: ts.ModuleKind.ESNext,
      });

      const currentSource = program.getSourceFile(change.filePath);
      const prevSource = program.getSourceFile(prevPath);

      const changedFunctions: Array<{ name: string; oldSig: string; newSig: string }> = [];
      const changedTypes: Array<{ name: string; oldDef: string; newDef: string }> = [];

      if (currentSource && prevSource) {
        const visit = (node: ts.Node, source: ts.SourceFile) => {
          if (ts.isFunctionDeclaration(node) && node.name) {
            const name = node.name.text;
            const oldNode = this.findNodeByName(
              prevSource,
              name,
              (n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n),
            );
            const newSig = this.signatureFromNode(node, source);
            const oldSig = oldNode ? this.signatureFromNode(oldNode, prevSource) : newSig;
            if (oldSig !== newSig) {
              changedFunctions.push({ name, oldSig, newSig });
            }
          }
          if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
            const name = node.name.text;
            const oldNode = this.findNodeByName(
              prevSource,
              name,
              (n): n is ts.InterfaceDeclaration | ts.TypeAliasDeclaration =>
                ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n),
            );
            const newDef = node.getText(source);
            const oldDef = oldNode ? oldNode.getText(prevSource) : newDef;
            if (oldDef !== newDef) {
              changedTypes.push({ name, oldDef, newDef });
            }
          }
          ts.forEachChild(node, (child) => visit(child, source));
        };
        visit(currentSource, currentSource);
      }

      return { changedFunctions, changedTypes };
    } finally {
      // Cleanup in finally: a throwing ts.createProgram must not leak the
      // temp file in os.tmpdir().
      try {
        fs.unlinkSync(prevPath);
      } catch {
        // ignore cleanup errors
      }
    }
  }

  getCallGraph(
    filePath: string,
    db?: DatabaseSync,
  ): Array<{ functionName: string; callSites: string[] }> {
    const database = db ?? this.db;
    if (!database) return [];
    try {
      const stmt = database.prepare(`
        SELECT from_f.name AS functionName, to_files.path AS callSite
        FROM calls c
        JOIN functions from_f ON c.from_function_id = from_f.id
        JOIN files from_files ON from_f.file_id = from_files.id
        JOIN functions to_f ON c.to_function_id = to_f.id
        LEFT JOIN files to_files ON to_f.file_id = to_files.id
        WHERE from_files.path = ?
      `);
      const rows = stmt.all(filePath) as Array<{ functionName: string; callSite: string | null }>;
      const map = new Map<string, Set<string>>();
      for (const row of rows) {
        if (!map.has(row.functionName)) map.set(row.functionName, new Set());
        if (row.callSite) map.get(row.functionName)!.add(row.callSite);
      }
      const result: Array<{ functionName: string; callSites: string[] }> = [];
      for (const [fn, sites] of map) {
        result.push({ functionName: fn, callSites: Array.from(sites) });
      }
      return result;
    } catch {
      return [];
    }
  }

  correlateHistoricalFailures(
    filePath: string,
    db?: DatabaseSync,
  ): { avgFailureRate: number; commonBrokenTests: string[] } {
    const database = db ?? this.db;
    if (!database) return { avgFailureRate: 0, commonBrokenTests: [] };
    try {
      const stmt = database.prepare(
        `SELECT failure_occurred, module_name FROM test_failure_log WHERE file_path = ?`,
      );
      const rows = stmt.all(filePath) as Array<{
        failure_occurred: number;
        module_name: string | null;
      }>;
      if (rows.length === 0) return { avgFailureRate: 0, commonBrokenTests: [] };
      const total = rows.length;
      const failures = rows.reduce((sum, r) => sum + (r.failure_occurred ? 1 : 0), 0);
      const avgFailureRate = failures / total;
      const broken = rows
        .filter((r) => r.failure_occurred)
        .map((r) => r.module_name)
        .filter((m): m is string => !!m);
      const commonBrokenTests = Array.from(new Set(broken));
      return { avgFailureRate, commonBrokenTests };
    } catch {
      return { avgFailureRate: 0, commonBrokenTests: [] };
    }
  }

  predictImpact(change: CodeChange): ImpactReport {
    const predictionId = `pred-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    let rawCross = change.crossModule ? this.config.crossModuleWeight : 0.1;
    let rawPrior = this.config.bayesianPrior;

    const scores: Record<string, number> = {
      crossModule: rawCross,
      prior: rawPrior,
      changeType: change.changeType === 'modify' ? 0.7 : 0.3,
    };

    const totalRaw = Object.values(scores).reduce((a, b) => a + b, 0);
    const normalized: Record<string, number> = {};
    for (const [k, v] of Object.entries(scores)) {
      normalized[k] = totalRaw > 0 ? v / totalRaw : 0;
    }

    const totalConfidence = 1 - Object.values(normalized).reduce((prod, c) => prod * (1 - c), 1);

    // Use real call-graph and historical data
    let affectedModules: string[] = [];
    try {
      const graph = this.getCallGraph(change.filePath, this.db);
      const modules = new Set<string>();
      for (const entry of graph) {
        for (const site of entry.callSites) {
          const parts = site.split(/[\\/]/);
          if (parts.length >= 2) {
            modules.add(parts[parts.length - 2]);
          } else if (parts.length === 1) {
            modules.add(parts[0]);
          }
        }
      }
      // Cross-module: include both source and target modules when cross-module
      if (change.crossModule) {
        modules.add(change.moduleName);
        // Also include target module from file path if different
        const targetModule = path.basename(path.dirname(change.filePath)) || change.moduleName;
        if (targetModule !== change.moduleName) modules.add(targetModule);
      }
      if (modules.size > 0) {
        affectedModules = Array.from(modules);
      } else {
        affectedModules = [change.moduleName];
      }
    } catch {
      affectedModules = change.crossModule
        ? [change.moduleName, path.basename(path.dirname(change.filePath)) || change.moduleName]
        : [change.moduleName];
    }

    let historical = { avgFailureRate: 0, commonBrokenTests: [] as string[] };
    try {
      historical = this.correlateHistoricalFailures(change.filePath, this.db);
    } catch {
      // ignore
    }

    const predictedImpact = Math.min(
      1,
      (rawCross + rawPrior) / 2 + historical.avgFailureRate * 0.2,
    );

    return {
      predictionId,
      change,
      predictedImpact,
      confidenceScores: normalized,
      totalConfidence: Math.min(1, Math.max(0, totalConfidence)),
      affectedModules,
      timestamp: new Date().toISOString(),
    };
  }

  recordOutcome(predictionId: string, actual: ActualImpact): void {
    this.outcomes.push(actual);
    const error = actual.failureOccurred ? 0.2 : -0.05;
    const currentCross = this.modelWeights.get('crossModule') ?? this.config.crossModuleWeight;
    this.modelWeights.set(
      'crossModule',
      Math.max(0.1, Math.min(1, currentCross + error * this.config.modelUpdateRate)),
    );

    if (this.db) {
      try {
        this.db.exec(
          `CREATE TABLE IF NOT EXISTS test_failure_log (id INTEGER PRIMARY KEY AUTOINCREMENT, prediction_id TEXT NOT NULL, file_path TEXT, module_name TEXT, failure_occurred BOOLEAN DEFAULT 0, severity TEXT DEFAULT 'medium', logged_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
        );
        const stmt = this.db.prepare(`
          INSERT INTO test_failure_log (prediction_id, file_path, module_name, failure_occurred, severity, logged_at)
          VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `);
        const moduleName = actual.actualAffectedModules?.[0] ?? 'unknown';
        stmt.run(
          predictionId,
          actual.filePath ?? null,
          moduleName,
          actual.failureOccurred ? 1 : 0,
          actual.severity,
        );
      } catch {
        // ignore persistence errors
      }
    }
  }

  computeRiskLevel(failures: PredictedFailure[]): 'low' | 'medium' | 'high' | 'critical' {
    return computeRiskLevel(failures);
  }

  predictTestBreaks(change: CodeChange): PredictedFailure[] {
    const diff = this.simulateDiff(change);
    const predictions: PredictedFailure[] = [];
    const callGraph = this.getCallGraph(change.filePath, this.db);

    for (const fn of diff.changedFunctions) {
      if (fn.oldSig !== fn.newSig) {
        const callers = callGraph.filter((c) => c.functionName === fn.name);
        const hasCallEdges = callers.length > 0;
        const arityOld = (fn.oldSig.match(/,/g) || []).length + 1;
        const arityNew = (fn.newSig.match(/,/g) || []).length + 1;
        const argMismatch = arityOld !== arityNew;

        // Check test-file callers for stale mocks (regex/AST-lite)
        let staleMock = false;
        let mockReason = '';
        for (const caller of callers) {
          for (const site of caller.callSites) {
            if (site.includes('.test.') || site.includes('.spec.')) {
              try {
                const content = fs.readFileSync(site, 'utf-8');
                const mockRegex = new RegExp(
                  '\\b' + fn.name + '\\b.*\\(' + (fn.name.length > 2 ? '.{0,40}' : '') + '\\)',
                );
                if (mockRegex.test(content)) {
                  // Check if mock references old arity (approximate by counting commas in mock call)
                  const mockCalls =
                    content.match(new RegExp('\\b' + fn.name + '\\b\\([^)]*\\)', 'g')) || [];
                  for (const mc of mockCalls) {
                    const commas = (mc.match(/,/g) || []).length;
                    if (commas + 1 !== arityNew) {
                      staleMock = true;
                      mockReason = `Mock at ${site} references old arity (${commas + 1} args vs new ${arityNew})`;
                    }
                  }
                }
              } catch {
                // ignore unreadable test files
              }
            }
          }
        }

        let reason = `Signature changed from ${fn.oldSig} to ${fn.newSig}`;
        let fix = `Update all call sites to match new signature ${fn.newSig}`;
        if (!hasCallEdges) {
          reason += '; no KG call edges found for this function (lower confidence)';
        }
        if (staleMock) {
          reason += '; ' + mockReason;
          fix += '; update mock arity in test files';
        }
        if (argMismatch) {
          reason += '; argument count mismatch detected';
          fix += '; verify argument counts at all callers';
        }

        predictions.push({
          filePath: change.filePath,
          functionName: fn.name,
          confidence: hasCallEdges ? 0.85 : 0.55,
          reason,
          suggestedFix: fix,
        });
      }
    }

    for (const type of diff.changedTypes) {
      predictions.push({
        filePath: change.filePath,
        functionName: type.name,
        confidence: 0.7,
        reason: `Type definition changed: ${type.oldDef.substring(0, 60)}${type.oldDef.length > 60 ? '...' : ''}`,
        suggestedFix: `Review usages of type ${type.name}`,
      });
    }

    // Assign riskLevel to each failure based on the overall set
    const riskLevel = this.computeRiskLevel(predictions);
    for (const failure of predictions) {
      failure.riskLevel = riskLevel;
    }

    return predictions;
  }

  getModelWeights(): Map<string, number> {
    return new Map(this.modelWeights);
  }

  getOutcomeCount(): number {
    return this.outcomes.length;
  }
}
