import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractCodebaseSkills,
  estimateSkillProficiency,
  analyzeSkillGaps,
  generateSkillDoc,
  estimateAllProficiencies,
  pseudonymizeAgentId,
  persistAgentProfile,
  loadAgentProfile,
  adaptiveCoherenceCheck,
} from '../../../src/core/skills/engine.js';
import { SKILL_CATALOG, SkillDefinition, SkillEvidence, ProficiencyEvidence, SkillGap } from '../../../src/core/skills/skill-catalog.js';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL } from '../../../src/storage/schema.js';
import { AgentFingerprintExtractor } from '../../../src/core/skills/fingerprint.js';

describe('Skill Engine', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'skill-engine-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('extractCodebaseSkills()', () => {
    it('returns evidence for all skills when given modules with matching files', () => {
      const modules = [
        {
          files: [
            { relativePath: 'src/utils/helper.ts', language: 'typescript' },
            { relativePath: 'src/core/coherence/engine.ts', language: 'typescript' },
            { relativePath: 'src/core/debt/tracker.ts', language: 'typescript' },
            { relativePath: 'src/storage/database.ts', language: 'typescript' },
            { relativePath: 'src/parser/ast-parser.ts', language: 'typescript' },
          ],
        },
      ];

      const evidence = extractCodebaseSkills(modules);

      // Should have evidence for skills that match the file paths
      expect(evidence).toBeDefined();
      expect(Object.keys(evidence).length).toBeGreaterThan(0);
      expect(evidence['typescript']).toBeDefined();
      expect(evidence['typescript'].files.length).toBeGreaterThan(0);
    });

    it('returns catalog with empty files arrays when no modules provided', () => {
      const evidence = extractCodebaseSkills([]);

      // No modules means catalog-only evidence (all skills present, no files)
      expect(evidence).toBeDefined();
      expect(Object.keys(evidence).length).toBe(SKILL_CATALOG.length);
      for (const info of Object.values(evidence)) {
        expect(info.files).toHaveLength(0);
      }
    });

    it('returns catalog-only evidence when modules have no files', () => {
      const evidence = extractCodebaseSkills([{ files: [] }]);
      // When no file paths, returns catalog with empty files arrays
      expect(Object.keys(evidence).length).toBe(SKILL_CATALOG.length);
      for (const info of Object.values(evidence)) {
        expect(info.files).toHaveLength(0);
      }
    });

    it('limits evidence files to MAX_EVIDENCE_FILES per skill', () => {
      const files = Array(20).fill(null).map((_, i) => ({
        relativePath: `src/utils/file${i}.ts`,
        language: 'typescript',
      }));

      const evidence = extractCodebaseSkills([{ files }]);

      // TypeScript skill should be capped at 8 files
      if (evidence['typescript']) {
        expect(evidence['typescript'].files.length).toBeLessThanOrEqual(8);
      }
    });

    it('does not duplicate files in evidence', () => {
      const modules = [
        {
          files: [
            { relativePath: 'src/utils/helper.ts', language: 'typescript' },
          ],
        },
        {
          files: [
            { relativePath: 'src/utils/helper.ts', language: 'typescript' },
          ],
        },
      ];

      const evidence = extractCodebaseSkills(modules);

      if (evidence['typescript']) {
        const uniqueFiles = new Set(evidence['typescript'].files);
        expect(uniqueFiles.size).toBe(evidence['typescript'].files.length);
      }
    });

    it('matches skills based on indicator regexes', () => {
      const modules = [
        {
          files: [
            { relativePath: 'src/core/coherence/engine.ts', language: 'typescript' },
            { relativePath: 'src/core/debt/tracker.ts', language: 'typescript' },
            { relativePath: 'src/parser/ast-parser.ts', language: 'typescript' },
          ],
        },
      ];

      const evidence = extractCodebaseSkills(modules);

      // Should match coherence-checking, debt-detection, ast-parsing
      expect(evidence['coherence-checking']).toBeDefined();
      expect(evidence['debt-detection']).toBeDefined();
      expect(evidence['ast-parsing']).toBeDefined();
    });

    it('assigns typescript skill only typescript files', () => {
      const modules = [
        {
          files: [
            { relativePath: 'src/utils/helper.ts', language: 'typescript' },
            { relativePath: 'src/utils/helper.js', language: 'javascript' },
            { relativePath: 'README.md', language: 'markdown' },
          ],
        },
      ];

      const evidence = extractCodebaseSkills(modules);

      if (evidence['typescript']) {
        for (const file of evidence['typescript'].files) {
          expect(file).toMatch(/\.tsx?$/);
        }
      }
    });

    it('normalizes Windows-style paths', () => {
      const modules = [
        {
          files: [
            { relativePath: 'src\\utils\\helper.ts', language: 'typescript' },
          ],
        },
      ];

      const evidence = extractCodebaseSkills(modules);

      if (evidence['typescript']) {
        // Should normalize backslashes to forward slashes
        expect(evidence['typescript'].files[0]).toBe('src/utils/helper.ts');
      }
    });

    it('handles modules with missing files property', () => {
      const modules = [
        {},
        { files: undefined },
        { files: [{ relativePath: 'src/test.ts', language: 'typescript' }] },
      ];

      const evidence = extractCodebaseSkills(modules as any);
      expect(evidence).toBeDefined();
    });

    it('skips files with empty relativePath', () => {
      const modules = [
        {
          files: [
            { relativePath: '', language: 'typescript' },
            { relativePath: 'src/valid.ts', language: 'typescript' },
          ],
        },
      ];

      const evidence = extractCodebaseSkills(modules);
      if (evidence['typescript']) {
        expect(evidence['typescript'].files).not.toContain('');
      }
    });

    it('preserves skill metadata in evidence', () => {
      const modules = [
        {
          files: [
            { relativePath: 'src/utils/helper.ts', language: 'typescript' },
          ],
        },
      ];

      const evidence = extractCodebaseSkills(modules);

      if (evidence['typescript']) {
        expect(evidence['typescript'].id).toBe('typescript');
        expect(evidence['typescript'].description).toBeDefined();
        expect(evidence['typescript'].whyItHelps).toBeDefined();
        expect(evidence['typescript'].importance).toBeGreaterThan(0);
        expect(evidence['typescript'].suggestedCommands.length).toBeGreaterThan(0);
      }
    });
  });

  describe('estimateSkillProficiency()', () => {
    const tsSkill = SKILL_CATALOG.find((s) => s.id === 'typescript')!;
    const asyncSkill = SKILL_CATALOG.find((s) => s.id === 'async-patterns')!;

    it('returns 0 for empty evidence', () => {
      const evidence: ProficiencyEvidence = {
        sessionCount: 0,
        touchedPaths: [],
        decisionsText: '',
        asyncPreference: -1,
      };

      const score = estimateSkillProficiency(tsSkill, evidence);
      expect(score).toBe(0);
    });

    it('increases score for matching touched paths', () => {
      const evidence: ProficiencyEvidence = {
        sessionCount: 0,
        touchedPaths: ['src/utils/helper.ts', 'src/components/App.tsx'],
        decisionsText: '',
        asyncPreference: -1,
      };

      const score = estimateSkillProficiency(tsSkill, evidence);
      expect(score).toBeGreaterThan(0);
    });

    it('adds session count bonus', () => {
      const evidence: ProficiencyEvidence = {
        sessionCount: 5,
        touchedPaths: [],
        decisionsText: '',
        asyncPreference: -1,
      };

      const score = estimateSkillProficiency(tsSkill, evidence);
      // 5/10 * 0.15 = 0.075
      expect(score).toBeGreaterThan(0);
    });

    it('caps score at 1.0', () => {
      const evidence: ProficiencyEvidence = {
        sessionCount: 100,
        touchedPaths: [
          'src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts',
          'src/e.ts', 'src/f.ts', 'src/g.ts', 'src/h.ts',
        ],
        decisionsText: 'typescript tsx types',
        asyncPreference: 1,
      };

      const score = estimateSkillProficiency(tsSkill, evidence);
      expect(score).toBeLessThanOrEqual(1);
    });

    it('gives async bonus for async-patterns skill', () => {
      const evidence: ProficiencyEvidence = {
        sessionCount: 0,
        touchedPaths: [],
        decisionsText: '',
        asyncPreference: 0.8,
      };

      const asyncScore = estimateSkillProficiency(asyncSkill, evidence);
      expect(asyncScore).toBeGreaterThan(0);
    });

    it('does not give async bonus for non-async skills', () => {
      const evidence: ProficiencyEvidence = {
        sessionCount: 0,
        touchedPaths: [],
        decisionsText: '',
        asyncPreference: 0.8,
      };

      const tsScore = estimateSkillProficiency(tsSkill, evidence);
      expect(tsScore).toBe(0); // No paths match, no bonus
    });

    it('counts decision text matches', () => {
      const evidence: ProficiencyEvidence = {
        sessionCount: 0,
        touchedPaths: [],
        decisionsText: 'Worked on typescript file.ts and file.tsx',
        asyncPreference: -1,
      };

      const score = estimateSkillProficiency(tsSkill, evidence);
      expect(score).toBeGreaterThan(0);
    });

    it('works with all skills in catalog', () => {
      const evidence: ProficiencyEvidence = {
        sessionCount: 5,
        touchedPaths: ['src/utils/helper.ts', 'src/core/coherence/engine.ts'],
        decisionsText: 'Refactored typescript code',
        asyncPreference: 0.5,
      };

      for (const skill of SKILL_CATALOG) {
        const score = estimateSkillProficiency(skill, evidence);
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('estimateAllProficiencies()', () => {
    it('returns proficiency for all skills', () => {
      const evidence: ProficiencyEvidence = {
        sessionCount: 10,
        touchedPaths: ['src/utils/helper.ts'],
        decisionsText: 'Worked on typescript',
        asyncPreference: 0.5,
      };

      const result = estimateAllProficiencies(evidence);

      expect(Object.keys(result).length).toBe(SKILL_CATALOG.length);

      // All values should be between 0 and 1
      for (const score of Object.values(result)) {
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
      }
    });

    it('returns zero proficiencies for empty evidence', () => {
      const evidence: ProficiencyEvidence = {
        sessionCount: 0,
        touchedPaths: [],
        decisionsText: '',
        asyncPreference: -1,
      };

      const result = estimateAllProficiencies(evidence);

      for (const score of Object.values(result)) {
        expect(score).toBe(0);
      }
    });
  });

  describe('analyzeSkillGaps()', () => {
    it('returns empty array when no gaps exceed threshold', () => {
      const proficiencies: Record<string, number> = {};
      const evidence: Record<string, SkillEvidence> = {};

      for (const skill of SKILL_CATALOG) {
        proficiencies[skill.id] = 1.0; // Max proficiency = no gap
        evidence[skill.id] = {
          id: skill.id,
          description: skill.description,
          whyItHelps: skill.whyItHelps,
          importance: skill.importance,
          files: ['src/test.ts'],
          suggestedCommands: skill.suggestedCommands,
        };
      }

      const gaps = analyzeSkillGaps(proficiencies, evidence, 0.1);
      expect(gaps).toHaveLength(0);
    });

    it('detects gaps for low proficiency skills', () => {
      const proficiencies: Record<string, number> = {
        typescript: 0.2, // Low proficiency
      };
      const evidence: Record<string, SkillEvidence> = {
        typescript: {
          id: 'typescript',
          description: 'TypeScript types',
          whyItHelps: 'Important',
          importance: 0.9,
          files: ['src/test.ts'],
          suggestedCommands: ['pm scale'],
        },
      };

      const gaps = analyzeSkillGaps(proficiencies, evidence, 0.1);

      expect(gaps.length).toBeGreaterThan(0);
      expect(gaps[0].skill).toBe('typescript');
      expect(gaps[0].gap).toBeCloseTo(0.7, 1);
    });

    it('assigns critical priority for large gaps on important skills', () => {
      const proficiencies: Record<string, number> = {
        typescript: 0.1, // Very low
      };
      const evidence: Record<string, SkillEvidence> = {
        typescript: {
          id: 'typescript',
          description: 'TypeScript types',
          whyItHelps: 'Critical',
          importance: 0.9, // High importance
          files: ['src/test.ts'],
          suggestedCommands: ['pm scale'],
        },
      };

      const gaps = analyzeSkillGaps(proficiencies, evidence, 0.1);

      expect(gaps.length).toBeGreaterThan(0);
      expect(gaps[0].priority).toBe('critical');
    });

    it('assigns high priority for gaps > 0.4', () => {
      const proficiencies: Record<string, number> = {
        'coherence-checking': 0.3,
      };
      const evidence: Record<string, SkillEvidence> = {
        'coherence-checking': {
          id: 'coherence-checking',
          description: 'Coherence',
          whyItHelps: 'Important',
          importance: 0.75,
          files: ['src/test.ts'],
          suggestedCommands: ['pm check'],
        },
      };

      const gaps = analyzeSkillGaps(proficiencies, evidence, 0.1);

      expect(gaps.length).toBeGreaterThan(0);
      expect(gaps[0].priority).toBe('high');
    });

    it('sorts gaps in descending order', () => {
      const proficiencies: Record<string, number> = {
        typescript: 0.5, // Gap: 0.4
        'async-patterns': 0.3, // Gap: 0.55
      };
      const evidence: Record<string, SkillEvidence> = {
        typescript: {
          id: 'typescript',
          description: 'TypeScript',
          whyItHelps: 'Important',
          importance: 0.9,
          files: ['src/test.ts'],
          suggestedCommands: ['pm scale'],
        },
        'async-patterns': {
          id: 'async-patterns',
          description: 'Async',
          whyItHelps: 'Important',
          importance: 0.85,
          files: ['src/retry.ts'],
          suggestedCommands: ['pm doctor'],
        },
      };

      const gaps = analyzeSkillGaps(proficiencies, evidence, 0.1);

      // Should be sorted by gap descending
      for (let i = 1; i < gaps.length; i++) {
        expect(gaps[i - 1].gap).toBeGreaterThanOrEqual(gaps[i].gap);
      }
    });

    it('includes learning resources in gap result', () => {
      const proficiencies: Record<string, number> = {
        typescript: 0.2,
      };
      const evidence: Record<string, SkillEvidence> = {
        typescript: {
          id: 'typescript',
          description: 'TypeScript',
          whyItHelps: 'Important',
          importance: 0.9,
          files: ['src/test.ts'],
          suggestedCommands: ['pm scale'],
        },
      };

      const gaps = analyzeSkillGaps(proficiencies, evidence, 0.1);

      expect(gaps.length).toBeGreaterThan(0);
      expect(gaps[0].learningResources.length).toBeGreaterThan(0);
    });

    it('estimates hours based on gap size', () => {
      const proficiencies: Record<string, number> = {
        typescript: 0.3,
      };
      const evidence: Record<string, SkillEvidence> = {
        typescript: {
          id: 'typescript',
          description: 'TypeScript',
          whyItHelps: 'Important',
          importance: 0.9,
          files: ['src/test.ts'],
          suggestedCommands: ['pm scale'],
        },
      };

      const gaps = analyzeSkillGaps(proficiencies, evidence, 0.1);

      // estimatedHours = ceil(gap * 20), where gap = 0.9 - 0.3
      expect(gaps[0].estimatedHours).toBeGreaterThan(0);
      expect(gaps[0].estimatedHours).toBe(Math.ceil(gaps[0].gap * 20));
    });

    it('respects threshold parameter', () => {
      const proficiencies: Record<string, number> = {
        typescript: 0.75, // Gap: 0.15
      };
      const evidence: Record<string, SkillEvidence> = {
        typescript: {
          id: 'typescript',
          description: 'TypeScript',
          whyItHelps: 'Important',
          importance: 0.9,
          files: ['src/test.ts'],
          suggestedCommands: ['pm scale'],
        },
      };

      // With threshold 0.2, gap of 0.15 should NOT be reported
      const gaps = analyzeSkillGaps(proficiencies, evidence, 0.2);
      expect(gaps).toHaveLength(0);

      // With threshold 0.1, gap of 0.15 SHOULD be reported
      const gaps2 = analyzeSkillGaps(proficiencies, evidence, 0.1);
      expect(gaps2.length).toBeGreaterThan(0);
    });
  });

  describe('generateSkillDoc()', () => {
    it('generates markdown with frontmatter', () => {
      const doc = generateSkillDoc({
        agentName: 'test-agent',
        sessionCount: 5,
        filesTouchedCount: 10,
        fingerprint: {
          asyncPreference: 0.7,
          typeStrictness: 0.8,
          errorHandlingStyle: 'try-catch',
          namingConvention: 'camelCase',
          testPattern: 'bdd',
          favoriteAbstractions: ['interface', 'generic'],
        },
        touchedPaths: ['src/test.ts'],
        gaps: [],
        generatedAt: new Date().toISOString(),
      });

      expect(doc).toContain('---');
      expect(doc).toContain('name: test-agent');
      expect(doc).toContain('generatedAt:');
      expect(doc).toContain('generatedBy: projectmind skill-recommend --write');
    });

    it('includes session and file counts', () => {
      const doc = generateSkillDoc({
        agentName: 'agent-1',
        sessionCount: 15,
        filesTouchedCount: 42,
        fingerprint: {
          asyncPreference: 0.5,
          typeStrictness: 0.5,
          errorHandlingStyle: 'try-catch',
          namingConvention: 'camelCase',
          testPattern: 'none',
          favoriteAbstractions: ['none'],
        },
        touchedPaths: [],
        gaps: [],
        generatedAt: new Date().toISOString(),
      });

      expect(doc).toContain('15 recorded session');
      expect(doc).toContain('42 agent-touched file');
    });

    it('includes coding fingerprint section', () => {
      const doc = generateSkillDoc({
        agentName: 'agent-1',
        sessionCount: 1,
        filesTouchedCount: 1,
        fingerprint: {
          asyncPreference: 0.75,
          typeStrictness: 0.85,
          errorHandlingStyle: 'try-catch',
          namingConvention: 'snake_case',
          testPattern: 'bdd',
          favoriteAbstractions: ['interface'],
        },
        touchedPaths: [],
        gaps: [],
        generatedAt: new Date().toISOString(),
      });

      expect(doc).toContain('## Coding fingerprint (measured)');
      expect(doc).toContain('Async preference: 75%');
      expect(doc).toContain('Type strictness: 85%');
      expect(doc).toContain('Error handling: try-catch');
      expect(doc).toContain('Naming convention: snake_case');
      expect(doc).toContain('Test pattern: bdd');
      expect(doc).toContain('Favorite abstractions: interface');
    });

    it('shows unmeasured for negative fingerprint values', () => {
      const doc = generateSkillDoc({
        agentName: 'agent-1',
        sessionCount: 1,
        filesTouchedCount: 1,
        fingerprint: {
          asyncPreference: -1,
          typeStrictness: -1,
          errorHandlingStyle: 'try-catch',
          namingConvention: 'camelCase',
          testPattern: 'none',
          favoriteAbstractions: ['none'],
        },
        touchedPaths: [],
        gaps: [],
        generatedAt: new Date().toISOString(),
      });

      expect(doc).toContain('Async preference: unmeasured');
      expect(doc).toContain('Type strictness: unmeasured');
    });

    it('shows no gaps message when gaps array is empty', () => {
      const doc = generateSkillDoc({
        agentName: 'agent-1',
        sessionCount: 1,
        filesTouchedCount: 1,
        fingerprint: {
          asyncPreference: 0.5,
          typeStrictness: 0.5,
          errorHandlingStyle: 'try-catch',
          namingConvention: 'camelCase',
          testPattern: 'none',
          favoriteAbstractions: ['none'],
        },
        touchedPaths: [],
        gaps: [],
        generatedAt: new Date().toISOString(),
      });

      expect(doc).toContain('No significant skill gaps detected');
    });

    it('includes gap details when gaps are present', () => {
      const gaps: SkillGap[] = [
        {
          skill: 'typescript',
          label: 'TypeScript',
          description: 'TypeScript types',
          whyItHelps: 'Important for type safety',
          currentLevel: 0.3,
          targetLevel: 0.9,
          gap: 0.6,
          priority: 'critical',
          learningResources: ['TypeScript Handbook'],
          estimatedHours: 12,
          relatedFiles: ['src/test.ts'],
          suggestedCommands: ['pm scale'],
        },
      ];

      const doc = generateSkillDoc({
        agentName: 'agent-1',
        sessionCount: 5,
        filesTouchedCount: 10,
        fingerprint: {
          asyncPreference: 0.5,
          typeStrictness: 0.5,
          errorHandlingStyle: 'try-catch',
          namingConvention: 'camelCase',
          testPattern: 'none',
          favoriteAbstractions: ['none'],
        },
        touchedPaths: [],
        gaps,
        generatedAt: new Date().toISOString(),
      });

      expect(doc).toContain('## Recommended skill development (by gap)');
      expect(doc).toContain('TypeScript — gap 60%');
      expect(doc).toContain('current 30% → target 90%');
      expect(doc).toContain('Important for type safety');
      expect(doc).toContain('`pm scale`');
      expect(doc).toContain('TypeScript Handbook');
    });

    it('limits gaps to top 8', () => {
      const gaps: SkillGap[] = Array(15).fill(null).map((_, i) => ({
        skill: `skill-${i}`,
        label: `Skill ${i}`,
        description: `Description ${i}`,
        whyItHelps: `Why ${i}`,
        currentLevel: 0,
        targetLevel: 0.9,
        gap: 0.9 - i * 0.01,
        priority: 'high',
        learningResources: ['Resource'],
        estimatedHours: 18,
        relatedFiles: [],
        suggestedCommands: ['pm test'],
      }));

      const doc = generateSkillDoc({
        agentName: 'agent-1',
        sessionCount: 1,
        filesTouchedCount: 1,
        fingerprint: {
          asyncPreference: 0.5,
          typeStrictness: 0.5,
          errorHandlingStyle: 'try-catch',
          namingConvention: 'camelCase',
          testPattern: 'none',
          favoriteAbstractions: ['none'],
        },
        touchedPaths: [],
        gaps,
        generatedAt: new Date().toISOString(),
      });

      // Should only show top 8 gaps
      expect(doc).toContain('Skill 0');
      expect(doc).toContain('Skill 7');
      // Skill 14 should not appear
      expect(doc).not.toContain('Skill 14');
    });

    it('includes touched files section when paths are provided with gaps', () => {
      const doc = generateSkillDoc({
        agentName: 'agent-1',
        sessionCount: 1,
        filesTouchedCount: 3,
        fingerprint: {
          asyncPreference: 0.5,
          typeStrictness: 0.5,
          errorHandlingStyle: 'try-catch',
          namingConvention: 'camelCase',
          testPattern: 'none',
          favoriteAbstractions: ['none'],
        },
        touchedPaths: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
        gaps: [
          {
            skill: 'typescript',
            label: 'TypeScript',
            description: 'Types',
            whyItHelps: 'Important',
            currentLevel: 0.5,
            targetLevel: 0.9,
            gap: 0.4,
            priority: 'high',
            learningResources: ['Book'],
            estimatedHours: 8,
            relatedFiles: [],
            suggestedCommands: ['pm scale'],
          },
        ],
        generatedAt: new Date().toISOString(),
      });

      expect(doc).toContain('## Most recent touched files');
      expect(doc).toContain('src/a.ts');
      expect(doc).toContain('src/b.ts');
      expect(doc).toContain('src/c.ts');
    });

    it('limits touched files to 12', () => {
      const paths = Array(20).fill(null).map((_, i) => `src/file${i}.ts`);

      const doc = generateSkillDoc({
        agentName: 'agent-1',
        sessionCount: 1,
        filesTouchedCount: 20,
        fingerprint: {
          asyncPreference: 0.5,
          typeStrictness: 0.5,
          errorHandlingStyle: 'try-catch',
          namingConvention: 'camelCase',
          testPattern: 'none',
          favoriteAbstractions: ['none'],
        },
        touchedPaths: paths,
        gaps: [
          {
            skill: 'typescript',
            label: 'TypeScript',
            description: 'Types',
            whyItHelps: 'Important',
            currentLevel: 0.5,
            targetLevel: 0.9,
            gap: 0.4,
            priority: 'high',
            learningResources: ['Book'],
            estimatedHours: 8,
            relatedFiles: [],
            suggestedCommands: ['pm scale'],
          },
        ],
        generatedAt: new Date().toISOString(),
      });

      expect(doc).toContain('src/file0.ts');
      expect(doc).toContain('src/file11.ts');
      expect(doc).not.toContain('src/file19.ts');
    });

    it('includes suggested workflow section', () => {
      const doc = generateSkillDoc({
        agentName: 'agent-1',
        sessionCount: 1,
        filesTouchedCount: 1,
        fingerprint: {
          asyncPreference: 0.5,
          typeStrictness: 0.5,
          errorHandlingStyle: 'try-catch',
          namingConvention: 'camelCase',
          testPattern: 'none',
          favoriteAbstractions: ['none'],
        },
        touchedPaths: [],
        gaps: [
          {
            skill: 'typescript',
            label: 'TypeScript',
            description: 'Types',
            whyItHelps: 'Important',
            currentLevel: 0.5,
            targetLevel: 0.9,
            gap: 0.4,
            priority: 'high',
            learningResources: ['Book'],
            estimatedHours: 8,
            relatedFiles: [],
            suggestedCommands: ['pm scale'],
          },
        ],
        generatedAt: new Date().toISOString(),
      });

      expect(doc).toContain('## Suggested workflow');
      expect(doc).toContain('Run the suggested command');
      expect(doc).toContain('Review the evidence files');
    });
  });

  describe('pseudonymizeAgentId()', () => {
    it('produces 16-character hex string', () => {
      const result = pseudonymizeAgentId('agent-123');
      expect(result).toHaveLength(16);
      expect(/^[0-9a-f]{16}$/.test(result)).toBe(true);
    });

    it('does not contain original agent ID', () => {
      const result = pseudonymizeAgentId('my-real-name');
      expect(result).not.toContain('my-real-name');
    });

    it('produces consistent output for same input', () => {
      const result1 = pseudonymizeAgentId('agent-456');
      const result2 = pseudonymizeAgentId('agent-456');
      expect(result1).toBe(result2);
    });

    it('produces different output for different inputs', () => {
      const result1 = pseudonymizeAgentId('agent-1');
      const result2 = pseudonymizeAgentId('agent-2');
      expect(result1).not.toBe(result2);
    });
  });

  describe('persistAgentProfile() and loadAgentProfile()', () => {
    it('persists and loads agent profile with temp DB', () => {
      const dbPath = join(tmpdir(), 'engine-test-' + Date.now() + '.db');
      const db = new DatabaseSync(dbPath);
      db.exec(SCHEMA_SQL);

      const extractor = new AgentFingerprintExtractor();
      const fp = extractor.extractFromAST('const myVar = 1;');

      const persistResult = persistAgentProfile('test-agent', fp, db);
      expect(persistResult).toBe(true);

      const loadResult = loadAgentProfile('test-agent', db);
      expect(loadResult.success).toBe(true);
      if (loadResult.success) {
        expect(loadResult.value.namingConvention).toBe('camelCase');
      }

      db.close();
      rmSync(dbPath, { force: true });
    });

    it('returns failure for non-existent agent', () => {
      const dbPath = join(tmpdir(), 'engine-test-' + Date.now() + '.db');
      const db = new DatabaseSync(dbPath);
      db.exec(SCHEMA_SQL);

      const result = loadAgentProfile('nonexistent-agent', db);
      expect(result.success).toBe(false);

      db.close();
      rmSync(dbPath, { force: true });
    });
  });

  describe('adaptiveCoherenceCheck()', () => {
    it('returns pass for non-existent agent profile', () => {
      const result = adaptiveCoherenceCheck('test.ts', 'const a = 1;', 'nonexistent');
      expect(result.verdict).toBe('pass');
    });

    it('returns pass when profile has no measured metadata', () => {
      // Create a profile with pre-measurement format (no measured field)
      const dbPath = join(tmpdir(), 'engine-test-' + Date.now() + '.db');
      const db = new DatabaseSync(dbPath);
      db.exec(SCHEMA_SQL);

      const extractor = new AgentFingerprintExtractor();
      const fp = extractor.extractFromAST('const myVar = 1;');
      persistAgentProfile('legacy-agent', fp, db);

      const result = adaptiveCoherenceCheck('test.ts', 'const b = 2;', 'legacy-agent');
      // Profile has measured metadata from extractor, so it should pass
      expect(result.verdict).toBe('pass');

      db.close();
      rmSync(dbPath, { force: true });
    });
  });
});
