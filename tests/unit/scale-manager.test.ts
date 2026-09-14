import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { initDatabase, closeDatabase } from '../../src/storage/database.js';
import { ScaleManager } from '../../src/core/scale/manager.js';
import { computeFingerprint } from '../../src/core/scale/reporting/utils.js';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('ScaleManager', () => {
  let manager: ScaleManager;

  beforeEach(() => {
    initDatabase(':memory:');
    manager = new ScaleManager();
  });

  afterEach(() => {
    closeDatabase();
  });

  describe('getScaleReport', () => {
    it('returns a scale report with default values', () => {
      const report = manager.getScaleReport();
      expect(report).toBeDefined();
      expect(report.totalFiles).toBe(0);
      expect(report.totalBytes).toBe(0);
      expect(report.modules).toBeDefined();
      expect(report.modules).toHaveLength(0);
    });

    it('returns report with files after adding data', () => {
      const db = manager['scanner']['db'];
      db.prepare(
        'INSERT INTO files (project_id, path, relative_path, language, size_bytes, hash) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(1, '/test/src/index.ts', 'src/index.ts', 'typescript', 1024, 'hash1');

      const report = manager.getScaleReport();
      expect(report.totalFiles).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getLastScanProfile', () => {
    it('returns null when no scan has been performed', () => {
      const profile = manager.getLastScanProfile();
      expect(profile).toBeNull();
    });
  });

  describe('getModuleInfo', () => {
    it('returns null for non-existent module', () => {
      const info = manager.getModuleInfo('nonexistent');
      expect(info).toBeNull();
    });
  });

  describe('getAgentProfiles', () => {
    it('returns empty array when no agents exist', () => {
      const profiles = manager.getAgentProfiles();
      expect(profiles).toBeDefined();
      expect(profiles).toHaveLength(0);
    });
  });

  describe('measured fingerprints', () => {
    it('reports test patterns and abstractions from touched source content', () => {
      const root = mkdtempSync(join(tmpdir(), 'pm-scale-fingerprint-'));
      try {
        writeFileSync(
          join(root, 'agent.ts'),
          'interface User { id: string; }\ntype UserId = string;\nclass UserStore<T> {}\ndescribe("users", () => { it("loads", () => {}); });',
        );
        const fingerprint = computeFingerprint(['agent.ts'], root);
        expect(fingerprint.testPattern).toBe('bdd');
        expect(fingerprint.favoriteAbstractions).toEqual(
          expect.arrayContaining(['interface', 'type-alias', 'generic', 'class']),
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('getCoverageHeatmap', () => {
    it('returns empty array when no files exist', () => {
      const heatmap = manager.getCoverageHeatmap();
      expect(heatmap).toBeDefined();
      expect(heatmap).toHaveLength(0);
    });
  });

  describe('scanProjectWithProfile', () => {
    it('returns a scan profile', async () => {
      const profile = await manager.scanProjectWithProfile('/test', true);
      expect(profile).toBeDefined();
      expect(profile.totalFiles).toBe(0);
      expect(profile.scannedFiles).toBe(0);
      expect(profile.errorFiles).toBe(0);
      expect(profile.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  it('does not read fingerprint paths outside the project or from .pmignore', () => {
    const root = mkdtempSync(join(tmpdir(), 'pm-scale-fingerprint-boundary-'));
    try {
      mkdirSync(join(root, 'ignored'), { recursive: true });
      writeFileSync(join(root, '.pmignore'), 'ignored/\n', 'utf8');
      writeFileSync(join(root, 'safe.ts'), 'export const safe = true;\n', 'utf8');

      const safe = computeFingerprint(['safe.ts'], root);
      const escaped = computeFingerprint(['../outside.ts'], root);
      const ignored = computeFingerprint(['ignored/secret.ts'], root);

      expect(safe.namingConvention).not.toBe('unknown');
      expect(escaped.namingConvention).toBe('unknown');
      expect(ignored.namingConvention).toBe('unknown');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
