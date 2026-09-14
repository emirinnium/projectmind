import { describe, expect, it, vi } from 'vitest';
import { PatternDriftDetector } from '../../../../src/core/debt/detection/pattern-drift.js';

function makeFile(relativePath = 'src/example.ts') {
  return {
    id: 1,
    path: `C:/project/${relativePath}`,
    relativePath,
    language: 'typescript',
    sizeBytes: 10,
    hash: 'hash',
    cognitiveLoad: 0,
    lastModified: new Date().toISOString(),
    agentTouched: false,
    agentTouchedBy: null,
    agentTouchedAt: null,
    lastScanned: new Date().toISOString(),
    lastSynced: new Date().toISOString(),
    patterns: [],
  };
}

function makePersistence() {
  return {
    createDebtItem: vi.fn((options) => ({
      id: 1,
      ...options,
      detectedAt: new Date().toISOString(),
      resolved: false,
    })),
  };
}

describe('PatternDriftDetector severity classification', () => {
  it('keeps aggregated fast heuristics visible without classifying them as blockers', async () => {
    const coherenceEngine = {
      checkCoherence: vi.fn().mockResolvedValue({
        verdict: 'fail',
        confidence: 0.4,
        reasoningTrace: [
          'Fast-tier analysis started',
          'Warning: File exceeds 400 lines (401) — cognitive load concern',
          'Warning: 3 functions with high cyclomatic complexity (>10 decision points)',
          'Fast-tier analysis complete. Issues found: 4',
        ],
        suggestions: ['Consider splitting this file into smaller modules'],
        llmProvider: 'fast-tier',
        responseTimeMs: 1,
      }),
    };
    const persistence = makePersistence();
    const detector = new PatternDriftDetector(coherenceEngine as never, persistence);

    await detector.detect(makeFile(), 'const value = 1;');

    expect(persistence.createDebtItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'pattern_drift',
        severity: 'low',
        description: 'Coherence heuristics require review in src/example.ts',
      }),
    );
  });

  it('keeps explicit architectural contract errors as high-severity debt', async () => {
    const coherenceEngine = {
      checkCoherence: vi.fn().mockResolvedValue({
        verdict: 'fail',
        confidence: 0.3,
        reasoningTrace: [
          'Fast-tier analysis started',
          '[Contract ERROR] no-domain-infra-import: forbidden import (line 3)',
          'Fast-tier analysis complete. Issues found: 3',
        ],
        suggestions: ['Fix architectural contract violation: forbidden import'],
        llmProvider: 'fast-tier',
        responseTimeMs: 1,
      }),
    };
    const persistence = makePersistence();
    const detector = new PatternDriftDetector(coherenceEngine as never, persistence);

    await detector.detect(makeFile(), 'import infra from "../infra.js";');

    expect(persistence.createDebtItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'pattern_drift',
        severity: 'high',
        description: 'Architectural pattern violation in src/example.ts',
      }),
    );
  });

  it('does not create debt for warnings or non-source files', async () => {
    const coherenceEngine = {
      checkCoherence: vi.fn().mockResolvedValue({
        verdict: 'warn',
        confidence: 0.7,
        reasoningTrace: ['Warning: one advisory signal'],
        suggestions: ['Review the signal'],
        llmProvider: 'fast-tier',
        responseTimeMs: 1,
      }),
    };
    const persistence = makePersistence();
    const detector = new PatternDriftDetector(coherenceEngine as never, persistence);

    await detector.detect(makeFile(), 'const value = 1;');
    await detector.detect(makeFile('tests/example.ts'), 'const value = 1;');

    expect(persistence.createDebtItem).not.toHaveBeenCalled();
    expect(coherenceEngine.checkCoherence).toHaveBeenCalledTimes(1);
  });
});
