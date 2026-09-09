import { describe, expect, it } from 'vitest';
import { inspectInstall } from '../../src/cli/commands/doctor-install.js';
import type { ProjectMindConfig } from '../../src/utils/config.js';

describe('doctor install checks', () => {
  it('returns structured checks and does not require a network call', () => {
    const report = inspectInstall({
      projectRoot: process.cwd(),
      databasePath: '.projectmind/pm-knowledge.db',
      embeddingsDir: '.projectmind/embeddings',
      maxDepth: 10,
      llm: {
        provider: 'simple',
        model: 'local',
        apiKey: undefined,
        deepModel: 'local',
        confidenceThreshold: 0.7,
        maxCacheSize: 10,
      },
      embeddings: {
        provider: 'simple',
        unixcoderModelPath: 'models/unixcoder.onnx',
        codebertModelPath: 'models/codebert.onnx',
        dimension: 8,
        openaiApiKey: undefined,
        openaiModel: 'local',
        transformersModel: 'local',
      },
      features: {
        coherenceEngine: true,
        debtTracker: true,
        scaleManager: true,
        memoryBridge: true,
      },
    } satisfies ProjectMindConfig);
    expect(report.checks.length).toBeGreaterThan(5);
    expect(report.checks.find((check) => check.name === 'dependency:@modelcontextprotocol/sdk')?.status).toBe(
      'pass',
    );
    expect(report.checks.every((check) => ['pass', 'warn', 'fail'].includes(check.status))).toBe(
      true,
    );
  });
});
