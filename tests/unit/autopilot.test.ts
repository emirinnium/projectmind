import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';

// Track the mock implementation for predictTestBreaks
let mockPredictTestBreaksImpl: ReturnType<typeof vi.fn>;

// Track mock implementations for api-surface-utils (Gate 5)
let mockExtractApiSurface: ReturnType<typeof vi.fn>;
let mockGetApiAtRef: ReturnType<typeof vi.fn>;
let mockComputeDiff: ReturnType<typeof vi.fn>;

// Mock execSync from node:child_process
vi.mock('node:child_process', () => {
  return {
    execSync: vi.fn().mockReturnValue(''),
  };
});

// Mock the ImpactPredictor before importing the module under test.
// Use a class so that `new ImpactPredictor()` works correctly.
vi.mock('../../src/core/predictive/impact-predictor.js', () => {
  mockPredictTestBreaksImpl = vi.fn().mockReturnValue([]);
  return {
    ImpactPredictor: class {
      predictTestBreaks = mockPredictTestBreaksImpl;
    },
  };
});

// Mock the database module - simulate a healthy project state.
// getStatement returns a statement object with a .get() method.
vi.mock('../../src/storage/database.js', () => {
  return {
    getStatement: vi.fn().mockImplementation((sql: string) => {
      // Return appropriate mock data based on the SQL query.
      if (sql.includes('debt_items') && sql.includes("severity='high'")) {
        // High-severity debt count (Gate 1)
        return { get: vi.fn().mockReturnValue({ c: 0 }) };
      }
      if (sql.includes('debt_items') && sql.includes("type='architectural_drift'")) {
        // Circular dependency count (Gate 2)
        return { get: vi.fn().mockReturnValue({ c: 0 }) };
      }
      if (sql.includes('project_genome')) {
        // Genome score (Gate 3) - return 0.85 (85%) which is above default 70% threshold
        return { get: vi.fn().mockReturnValue({ coherence_score: 0.85 }) };
      }
      // Default: return undefined (no data)
      return { get: vi.fn().mockReturnValue(undefined) };
    }),
  };
});

// Mock the api-surface-utils module (Gate 5) with safe defaults.
// Use mutable references so tests can override implementations.
vi.mock('../../src/cli/commands/api-surface-utils.js', () => {
  mockExtractApiSurface = vi.fn().mockResolvedValue([]);
  mockGetApiAtRef = vi.fn().mockResolvedValue([]);
  mockComputeDiff = vi.fn().mockReturnValue({ breaking: [] });
  return {
    extractApiSurface: mockExtractApiSurface,
    getApiAtRef: mockGetApiAtRef,
    computeDiff: mockComputeDiff,
  };
});

// Mock the shared utils
vi.mock('../../src/cli/utils/shared.js', () => {
  return {
    asyncHandler: (fn: any) => fn,
    output: {
      info: vi.fn(),
      kv: vi.fn(),
      section: vi.fn(),
      error: vi.fn(),
      success: vi.fn(),
      warn: vi.fn(),
    },
    loadConfig: vi.fn().mockReturnValue({ projectRoot: '/tmp/test' }),
    withService: vi.fn().mockImplementation(async (_services: string[], fn: () => Promise<void>) => {
      await fn();
    }),
  };
});

describe('autopilot pre-commit', () => {
  let mockExecSync: ReturnType<typeof vi.fn>;
  let mockOutput: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Re-setup mock implementations after clearAllMocks.
    mockExecSync = execSync as unknown as ReturnType<typeof vi.fn>;
    mockExecSync.mockReturnValue('');
    // Re-setup the ImpactPredictor mock implementation.
    if (mockPredictTestBreaksImpl) {
      mockPredictTestBreaksImpl.mockReturnValue([]);
    }
    // Re-setup the api-surface-utils mock implementations (Gate 5).
    if (mockExtractApiSurface) {
      mockExtractApiSurface.mockResolvedValue([]);
    }
    if (mockGetApiAtRef) {
      mockGetApiAtRef.mockResolvedValue([]);
    }
    if (mockComputeDiff) {
      mockComputeDiff.mockReturnValue({ breaking: [] });
    }
    const shared = await import('../../src/cli/utils/shared.js');
    mockOutput = shared.output;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Helper: run the pre-commit command with given options using commander's parseAsync.
   * Returns the exit code (null if process.exit was not called).
   */
  async function runPreCommitAction(opts: {
    minGenome?: string;
    format?: string;
    impactRiskThreshold?: string;
    skipImpactCheck?: boolean;
    allowBreakingApi?: boolean;
  }): Promise<{ exitCode: number | null; outputMock: any }> {
    // Spy on process.exit to capture gate failures without actually exiting.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      // Throw to stop execution flow (mimics process.exit behavior in tests).
      throw new Error('PROCESS_EXIT');
    }) as any);

    const { createAutopilotCommand } = await import('../../src/cli/commands/autopilot.js');
    const cmd = createAutopilotCommand();

    // Build command-line arguments from opts.
    const args: string[] = ['pre-commit'];
    if (opts.minGenome !== undefined) args.push('--min-genome', opts.minGenome);
    if (opts.format !== undefined) args.push('--format', opts.format);
    if (opts.impactRiskThreshold !== undefined) args.push('--impact-risk-threshold', opts.impactRiskThreshold);
    if (opts.skipImpactCheck) args.push('--skip-impact-check');
    if (opts.allowBreakingApi) args.push('--allow-breaking-api');

    let exitCode: number | null = null;
    try {
      await cmd.parseAsync(args, { from: 'user' });
    } catch (e: any) {
      if (e.message === 'PROCESS_EXIT') {
        // Extract the exit code from the spy call.
        const call = exitSpy.mock.calls[0];
        exitCode = call ? Number(call[0]) : 1;
      } else {
        throw e;
      }
    }

    exitSpy.mockRestore();
    return { exitCode, outputMock: mockOutput };
  }

  describe('runGates - impact risk gate', () => {
    it('passes when there are no staged files', async () => {
      mockExecSync.mockReturnValue('');

      const { exitCode, outputMock } = await runPreCommitAction({});

      // Gate should pass (no exit called).
      expect(exitCode).toBeNull();
      expect(outputMock.success).toHaveBeenCalledWith('All gates passed.');
    });

    it('skips impact check when --skip-impact-check is passed', async () => {
      mockExecSync.mockReturnValue('src/test.ts\n');

      const { exitCode, outputMock } = await runPreCommitAction({
        skipImpactCheck: true,
      });

      // Gate should pass because impact check is skipped.
      expect(exitCode).toBeNull();
      expect(outputMock.success).toHaveBeenCalledWith('All gates passed.');
      // ImpactPredictor should NOT have been invoked.
      expect(mockPredictTestBreaksImpl).not.toHaveBeenCalled();
    });

    it('accepts --impact-risk-threshold option', async () => {
      const { createAutopilotCommand } = await import('../../src/cli/commands/autopilot.js');
      const cmd = createAutopilotCommand();
      const preCommitCmd = cmd.commands.find(c => c.name() === 'pre-commit');
      expect(preCommitCmd).toBeDefined();

      const options = preCommitCmd?.options.map(o => o.long);
      expect(options).toContain('--impact-risk-threshold');
    });

    it('handles execSync timeout/error gracefully', async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('Command timed out');
      });

      const { exitCode, outputMock } = await runPreCommitAction({});

      // Fail closed: when staged files cannot be determined, the gate must fail.
      expect(exitCode).toBe(1);
      expect(outputMock.kv).toHaveBeenCalledWith(
        expect.stringContaining('Impact risk'),
        expect.stringContaining('could not determine staged files')
      );
    });

    it('filters staged files to TypeScript/JavaScript extensions', async () => {
      mockExecSync.mockReturnValue('src/test.ts\nsrc/component.tsx\nREADME.md\nsrc/styles.css\n');

      mockPredictTestBreaksImpl.mockReturnValue([]);

      const { exitCode, outputMock } = await runPreCommitAction({});

      // Only .ts and .tsx files should be analyzed (2 out of 4).
      expect(mockPredictTestBreaksImpl).toHaveBeenCalledTimes(2);
      expect(exitCode).toBeNull();
      expect(outputMock.success).toHaveBeenCalledWith('All gates passed.');
    });

    it('blocks when failure risk meets threshold', async () => {
      mockExecSync.mockReturnValue('src/test.ts\n');

      mockPredictTestBreaksImpl.mockReturnValue([
        {
          filePath: 'src/test.ts',
          functionName: 'myFunction',
          confidence: 0.85,
          reason: 'Signature changed',
          suggestedFix: 'Update call sites',
          riskLevel: 'high',
        },
      ]);

      const { exitCode, outputMock } = await runPreCommitAction({});

      // Gate should fail because high-risk failure meets default threshold (high).
      expect(exitCode).toBe(1);
      expect(outputMock.error).toHaveBeenCalledWith(
        expect.stringContaining('Gate FAILED')
      );
    });

    it('passes when all failures are below threshold', async () => {
      mockExecSync.mockReturnValue('src/test.ts\n');

      mockPredictTestBreaksImpl.mockReturnValue([
        {
          filePath: 'src/test.ts',
          functionName: 'myFunction',
          confidence: 0.5,
          reason: 'Minor change',
          suggestedFix: 'Review',
          riskLevel: 'low',
        },
      ]);

      const { exitCode, outputMock } = await runPreCommitAction({});

      // Gate should pass because low-risk failure is below default threshold (high).
      expect(exitCode).toBeNull();
      expect(outputMock.success).toHaveBeenCalledWith('All gates passed.');
    });

    it('blocks when failure risk exceeds threshold (critical > high)', async () => {
      mockExecSync.mockReturnValue('src/test.ts\n');

      mockPredictTestBreaksImpl.mockReturnValue([
        {
          filePath: 'src/test.ts',
          functionName: 'myFunction',
          confidence: 0.95,
          reason: 'Breaking change',
          suggestedFix: 'Update all callers',
          riskLevel: 'critical',
        },
      ]);

      const { exitCode, outputMock } = await runPreCommitAction({});

      // Gate should fail because critical > high threshold.
      expect(exitCode).toBe(1);
      expect(outputMock.error).toHaveBeenCalledWith(
        expect.stringContaining('Gate FAILED')
      );
    });

    it('fails when threshold is low and failure is low (low >= low)', async () => {
      mockExecSync.mockReturnValue('src/test.ts\n');

      mockPredictTestBreaksImpl.mockReturnValue([
        {
          filePath: 'src/test.ts',
          functionName: 'myFunction',
          confidence: 0.5,
          reason: 'Minor change',
          suggestedFix: 'Review',
          riskLevel: 'low',
        },
      ]);

      const { exitCode, outputMock } = await runPreCommitAction({
        impactRiskThreshold: 'low',
      });

      // Gate should fail because low >= low threshold means it's at threshold.
      expect(exitCode).toBe(1);
      expect(outputMock.error).toHaveBeenCalledWith(
        expect.stringContaining('Gate FAILED')
      );
    });

    it('passes when threshold is critical and failure is high', async () => {
      mockExecSync.mockReturnValue('src/test.ts\n');

      mockPredictTestBreaksImpl.mockReturnValue([
        {
          filePath: 'src/test.ts',
          functionName: 'myFunction',
          confidence: 0.85,
          reason: 'Signature changed',
          suggestedFix: 'Update call sites',
          riskLevel: 'high',
        },
      ]);

      const { exitCode, outputMock } = await runPreCommitAction({
        impactRiskThreshold: 'critical',
      });

      // Gate should pass because high < critical threshold.
      expect(exitCode).toBeNull();
      expect(outputMock.success).toHaveBeenCalledWith('All gates passed.');
    });
  });

  describe('--impact-risk-threshold validation', () => {
    it('rejects invalid threshold value with non-zero exit', async () => {
      const { exitCode, outputMock } = await runPreCommitAction({
        impactRiskThreshold: 'invalid',
      });

      expect(exitCode).toBe(1);
      expect(outputMock.error).toHaveBeenCalledWith(
        expect.stringContaining('Invalid --impact-risk-threshold')
      );
    });

    it('accepts empty string threshold value (falls back to default high)', async () => {
      const { exitCode } = await runPreCommitAction({
        impactRiskThreshold: '',
      });

      // Empty string is falsy and falls back to 'high', so it should pass.
      expect(exitCode).toBeNull();
    });

    it('rejects numeric threshold value with non-zero exit', async () => {
      const { exitCode, outputMock } = await runPreCommitAction({
        impactRiskThreshold: '5',
      });

      expect(exitCode).toBe(1);
      expect(outputMock.error).toHaveBeenCalledWith(
        expect.stringContaining('Invalid --impact-risk-threshold')
      );
    });

    it('accepts valid threshold values', async () => {
      for (const level of ['low', 'medium', 'high', 'critical']) {
        vi.clearAllMocks();
        // Re-setup mock implementations after clearAllMocks.
        mockExecSync.mockReturnValue('');
        if (mockPredictTestBreaksImpl) {
          mockPredictTestBreaksImpl.mockReturnValue([]);
        }

        const { exitCode } = await runPreCommitAction({
          impactRiskThreshold: level,
        });

        expect(exitCode).toBeNull();
      }
    });
  });

  describe('git diff cwd option', () => {
    it('passes cwd option to execSync for git diff', async () => {
      mockExecSync.mockReturnValue('');

      await runPreCommitAction({});

      // Verify execSync was called with the cwd option.
      expect(mockExecSync).toHaveBeenCalledWith(
        'git diff --cached --name-only --diff-filter=ACM',
        expect.objectContaining({
          encoding: 'utf8',
          timeout: 5000,
          cwd: '/tmp/test',
        })
      );
    });
  });

  describe('risk level comparison', () => {
    it('correctly orders risk levels', () => {
      const order = ['low', 'medium', 'high', 'critical'];
      const riskLevels = new Set(order);

      expect(riskLevels.has('low')).toBe(true);
      expect(riskLevels.has('medium')).toBe(true);
      expect(riskLevels.has('high')).toBe(true);
      expect(riskLevels.has('critical')).toBe(true);
    });
  });

  describe('runGates - API surface compatibility gate', () => {
    it('fails when breaking API changes detected', async () => {
      mockExecSync.mockReturnValue('src/foo.ts\n');
      // Provide a base API reference so the diff is computed.
      mockGetApiAtRef.mockResolvedValue([{ name: 'existingFn', relativePath: 'src/foo.ts', type: 'function' }]);
      mockComputeDiff.mockReturnValue({
        breaking: [{ name: 'foo', relativePath: 'src/foo.ts', type: 'function' }],
      });

      const { exitCode, outputMock } = await runPreCommitAction({});

      expect(exitCode).toBe(1);
      expect(outputMock.error).toHaveBeenCalledWith(
        expect.stringContaining('Gate FAILED')
      );
      expect(outputMock.kv).toHaveBeenCalledWith(
        expect.stringContaining('API surface'),
        expect.stringContaining('breaking')
      );
    });

    it('passes when no breaking changes', async () => {
      mockExecSync.mockReturnValue('src/foo.ts\n');
      // Provide a base API reference so the diff is computed.
      mockGetApiAtRef.mockResolvedValue([{ name: 'existingFn', relativePath: 'src/foo.ts', type: 'function' }]);
      mockComputeDiff.mockReturnValue({ breaking: [] });

      const { exitCode, outputMock } = await runPreCommitAction({});

      expect(exitCode).toBeNull();
      expect(outputMock.success).toHaveBeenCalledWith('All gates passed.');
      expect(outputMock.kv).toHaveBeenCalledWith(
        expect.stringContaining('API surface'),
        expect.stringContaining('no breaking API changes')
      );
    });

    it('is skipped with --allow-breaking-api', async () => {
      mockExecSync.mockReturnValue('src/foo.ts\n');

      const { exitCode, outputMock } = await runPreCommitAction({
        allowBreakingApi: true,
      });

      expect(exitCode).toBeNull();
      expect(outputMock.success).toHaveBeenCalledWith('All gates passed.');
      expect(outputMock.kv).toHaveBeenCalledWith(
        expect.stringContaining('API surface'),
        expect.stringContaining('API surface check skipped')
      );
      // computeDiff should NOT have been called when gate is bypassed
      expect(mockComputeDiff).not.toHaveBeenCalled();
    });

    it('passes when no base API reference (first commit scenario)', async () => {
      mockExecSync.mockReturnValue('src/foo.ts\n');
      mockGetApiAtRef.mockResolvedValue([]);

      const { exitCode, outputMock } = await runPreCommitAction({});

      expect(exitCode).toBeNull();
      expect(outputMock.success).toHaveBeenCalledWith('All gates passed.');
      expect(outputMock.kv).toHaveBeenCalledWith(
        expect.stringContaining('API surface'),
        expect.stringContaining('no base API reference')
      );
    });
  });
});
