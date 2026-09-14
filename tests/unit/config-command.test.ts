import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  initializeConfigFile,
  redactConfigSecrets,
  setConfigFileValue,
} from '@/cli/commands/config.js';

describe('config command file operations', () => {
  it('creates a sparse file once and applies validated dotted overrides', () => {
    const root = mkdtempSync(join(tmpdir(), 'projectmind-config-command-'));
    const file = join(root, 'config.json');
    try {
      expect(initializeConfigFile(file)).toBe(true);
      expect(initializeConfigFile(file)).toBe(false);
      setConfigFileValue(file, 'llm.model', '"local-model"');
      setConfigFileValue(file, 'maxDepth', '4');
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
        llm: { model: 'local-model' },
        maxDepth: 4,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects unsupported keys and invalid typed values before writing', () => {
    const root = mkdtempSync(join(tmpdir(), 'projectmind-config-command-'));
    const file = join(root, 'config.json');
    try {
      expect(() => setConfigFileValue(file, 'unknown.setting', 'true')).toThrow(
        /Unsupported config key/,
      );
      expect(() => setConfigFileValue(file, 'maxDepth', '"not-a-number"')).toThrow(
        /Invalid value for maxDepth/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('redacts nested credentials without changing non-secret config values', () => {
    expect(
      redactConfigSecrets({
        llm: { apiKey: 'secret', model: 'local' },
        embeddings: { openaiApiKey: 'another-secret' },
        maxDepth: 5,
      }),
    ).toEqual({
      llm: { apiKey: '<redacted>', model: 'local' },
      embeddings: { openaiApiKey: '<redacted>' },
      maxDepth: 5,
    });
  });
});
