import { describe, it, expect } from 'vitest';
import { SKILL_CATALOG, SkillDefinition } from '../../../src/core/skills/skill-catalog.js';

describe('SKILL_CATALOG', () => {
  describe('catalog completeness', () => {
    it('contains all expected skills', () => {
      const expectedIds = [
        'typescript',
        'async-patterns',
        'dependency-injection',
        'architectural-contracts',
        'coherence-checking',
        'debt-detection',
        'embedding-generation',
        'ast-parsing',
        'knowledge-graph',
        'sqlite-persistence',
        'mcp-protocol',
        'llm-integration',
        'cli-design',
        'testing-patterns',
        'security-auditing',
        'license-compliance',
        'architecture-analysis',
        'agent-session-management',
        'pattern-extraction',
        'refactoring-automation',
        'documentation-generation',
      ];

      const actualIds = SKILL_CATALOG.map((s) => s.id);
      for (const id of expectedIds) {
        expect(actualIds).toContain(id);
      }
    });

    it('has exactly 21 skills', () => {
      expect(SKILL_CATALOG).toHaveLength(21);
    });
  });

  describe('skill ID uniqueness', () => {
    it('has no duplicate IDs', () => {
      const ids = SKILL_CATALOG.map((s) => s.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });

    it('has no duplicate labels', () => {
      const labels = SKILL_CATALOG.map((s) => s.label);
      const uniqueLabels = new Set(labels);
      expect(uniqueLabels.size).toBe(labels.length);
    });
  });

  describe('skill structure validation', () => {
    it('all skills have required fields', () => {
      for (const skill of SKILL_CATALOG) {
        expect(skill.id).toBeDefined();
        expect(typeof skill.id).toBe('string');
        expect(skill.id.length).toBeGreaterThan(0);

        expect(skill.label).toBeDefined();
        expect(typeof skill.label).toBe('string');
        expect(skill.label.length).toBeGreaterThan(0);

        expect(skill.description).toBeDefined();
        expect(typeof skill.description).toBe('string');
        expect(skill.description.length).toBeGreaterThan(0);

        expect(skill.whyItHelps).toBeDefined();
        expect(typeof skill.whyItHelps).toBe('string');
        expect(skill.whyItHelps.length).toBeGreaterThan(0);

        expect(skill.importance).toBeDefined();
        expect(typeof skill.importance).toBe('number');
        expect(skill.importance).toBeGreaterThanOrEqual(0);
        expect(skill.importance).toBeLessThanOrEqual(1);

        expect(skill.indicators).toBeDefined();
        expect(Array.isArray(skill.indicators)).toBe(true);
        expect(skill.indicators.length).toBeGreaterThan(0);

        expect(skill.resources).toBeDefined();
        expect(Array.isArray(skill.resources)).toBe(true);
        expect(skill.resources.length).toBeGreaterThan(0);

        expect(skill.suggestedCommands).toBeDefined();
        expect(Array.isArray(skill.suggestedCommands)).toBe(true);
        expect(skill.suggestedCommands.length).toBeGreaterThan(0);
      }
    });

    it('all skills have at least one indicator regex', () => {
      for (const skill of SKILL_CATALOG) {
        expect(skill.indicators.length).toBeGreaterThan(0);
        for (const indicator of skill.indicators) {
          expect(indicator).toBeInstanceOf(RegExp);
        }
      }
    });
  });

  describe('indicator regex matching', () => {
    const testCases: Array<{ skillId: string; path: string; shouldMatch: boolean }> = [
      // typescript
      { skillId: 'typescript', path: 'src/utils/helper.ts', shouldMatch: true },
      { skillId: 'typescript', path: 'src/components/App.tsx', shouldMatch: true },
      { skillId: 'typescript', path: 'README.md', shouldMatch: false },
      { skillId: 'typescript', path: 'package.json', shouldMatch: false },

      // async-patterns
      { skillId: 'async-patterns', path: 'src/utils/retry.ts', shouldMatch: true },
      { skillId: 'async-patterns', path: 'src/services/api.ts', shouldMatch: false },

      // dependency-injection
      { skillId: 'dependency-injection', path: 'src/services/auth.ts', shouldMatch: true },
      { skillId: 'dependency-injection', path: 'src/container/factory.ts', shouldMatch: true },
      { skillId: 'dependency-injection', path: 'src/utils/helper.ts', shouldMatch: false },

      // architectural-contracts
      { skillId: 'architectural-contracts', path: 'src/contracts/layers.ts', shouldMatch: true },
      { skillId: 'architectural-contracts', path: 'src/layers.ts', shouldMatch: true },
      { skillId: 'architectural-contracts', path: 'src/utils/helper.ts', shouldMatch: false },

      // coherence-checking
      { skillId: 'coherence-checking', path: 'src/core/coherence/engine.ts', shouldMatch: true },
      { skillId: 'coherence-checking', path: 'src/core/coherence.ts', shouldMatch: true },
      { skillId: 'coherence-checking', path: 'src/utils/helper.ts', shouldMatch: false },

      // debt-detection
      { skillId: 'debt-detection', path: 'src/core/debt/tracker.ts', shouldMatch: true },
      { skillId: 'debt-detection', path: 'src/core/debt-prioritize.ts', shouldMatch: true },
      { skillId: 'debt-detection', path: 'src/utils/dedup.ts', shouldMatch: true },
      { skillId: 'debt-detection', path: 'src/utils/helper.ts', shouldMatch: false },

      // embedding-generation
      { skillId: 'embedding-generation', path: 'src/core/embeddings/provider.ts', shouldMatch: true },
      { skillId: 'embedding-generation', path: 'src/utils/helper.ts', shouldMatch: false },

      // ast-parsing
      { skillId: 'ast-parsing', path: 'src/parser/ast-parser.ts', shouldMatch: true },
      { skillId: 'ast-parsing', path: 'src/utils/structural-search.ts', shouldMatch: true },
      { skillId: 'ast-parsing', path: 'src/utils/tree-sitter.ts', shouldMatch: true },
      { skillId: 'ast-parsing', path: 'src/utils/helper.ts', shouldMatch: false },

      // knowledge-graph
      { skillId: 'knowledge-graph', path: 'src/storage/kg/graph.ts', shouldMatch: true },
      { skillId: 'knowledge-graph', path: 'src/storage/graph.ts', shouldMatch: true },
      { skillId: 'knowledge-graph', path: 'src/utils/imports.ts', shouldMatch: true },
      { skillId: 'knowledge-graph', path: 'src/utils/helper.ts', shouldMatch: false },

      // sqlite-persistence
      { skillId: 'sqlite-persistence', path: 'src/storage/database.ts', shouldMatch: true },
      { skillId: 'sqlite-persistence', path: 'src/storage/schema.ts', shouldMatch: true },
      { skillId: 'sqlite-persistence', path: 'src/storage/migrations.ts', shouldMatch: true },
      { skillId: 'sqlite-persistence', path: 'src/utils/helper.ts', shouldMatch: false },

      // mcp-protocol
      { skillId: 'mcp-protocol', path: 'src/mcp/server.ts', shouldMatch: true },
      { skillId: 'mcp-protocol', path: 'src/mcp-server.ts', shouldMatch: true },
      { skillId: 'mcp-protocol', path: 'src/utils/helper.ts', shouldMatch: false },

      // llm-integration
      { skillId: 'llm-integration', path: 'src/core/llm/provider.ts', shouldMatch: true },
      { skillId: 'llm-integration', path: 'src/core/deep.ts', shouldMatch: true },
      { skillId: 'llm-integration', path: 'src/utils/helper.ts', shouldMatch: false },

      // cli-design
      { skillId: 'cli-design', path: 'src/cli/index.ts', shouldMatch: true },
      { skillId: 'cli-design', path: 'src/utils/commander.ts', shouldMatch: true },
      { skillId: 'cli-design', path: 'src/utils/helper.ts', shouldMatch: false },

      // testing-patterns
      { skillId: 'testing-patterns', path: 'tests/unit/example.test.ts', shouldMatch: true },
      { skillId: 'testing-patterns', path: 'src/utils/__tests__/helper.ts', shouldMatch: true },
      { skillId: 'testing-patterns', path: 'src/utils/helper.ts', shouldMatch: false },

      // security-auditing
      { skillId: 'security-auditing', path: 'src/core/audit.ts', shouldMatch: true },
      { skillId: 'security-auditing', path: 'src/core/secrets-life.ts', shouldMatch: true },
      { skillId: 'security-auditing', path: 'src/core/taint/analyzer.ts', shouldMatch: true },
      { skillId: 'security-auditing', path: 'src/auth/middleware.ts', shouldMatch: true },
      { skillId: 'security-auditing', path: 'src/utils/helper.ts', shouldMatch: false },

      // license-compliance
      { skillId: 'license-compliance', path: 'src/core/license.ts', shouldMatch: true },
      { skillId: 'license-compliance', path: 'src/core/sbom.ts', shouldMatch: true },
      { skillId: 'license-compliance', path: 'src/core/deps-fresh.ts', shouldMatch: true },
      { skillId: 'license-compliance', path: 'src/utils/helper.ts', shouldMatch: false },

      // architecture-analysis
      { skillId: 'architecture-analysis', path: 'src/core/coupling.ts', shouldMatch: true },
      { skillId: 'architecture-analysis', path: 'src/core/impact.ts', shouldMatch: true },
      { skillId: 'architecture-analysis', path: 'src/core/layers.ts', shouldMatch: true },
      { skillId: 'architecture-analysis', path: 'src/utils/refactor-roi.ts', shouldMatch: true },
      { skillId: 'architecture-analysis', path: 'src/utils/helper.ts', shouldMatch: false },

      // agent-session-management
      { skillId: 'agent-session-management', path: 'src/core/session/tracker.ts', shouldMatch: true },
      { skillId: 'agent-session-management', path: 'src/core/agent/manager.ts', shouldMatch: true },
      { skillId: 'agent-session-management', path: 'src/core/memory/store.ts', shouldMatch: true },
      { skillId: 'agent-session-management', path: 'src/utils/helper.ts', shouldMatch: false },

      // pattern-extraction
      { skillId: 'pattern-extraction', path: 'src/parser/patterns/library.ts', shouldMatch: true },
      { skillId: 'pattern-extraction', path: 'src/parser/pattern-extractor.ts', shouldMatch: true },
      { skillId: 'pattern-extraction', path: 'src/utils/helper.ts', shouldMatch: false },

      // refactoring-automation
      { skillId: 'refactoring-automation', path: 'src/core/refactor/transforms.ts', shouldMatch: true },
      { skillId: 'refactoring-automation', path: 'src/core/organize-imports/index.ts', shouldMatch: true },
      { skillId: 'refactoring-automation', path: 'src/utils/helper.ts', shouldMatch: false },

      // documentation-generation
      { skillId: 'documentation-generation', path: 'src/core/docgen.ts', shouldMatch: true },
      { skillId: 'documentation-generation', path: 'src/core/adr.ts', shouldMatch: true },
      { skillId: 'documentation-generation', path: 'src/core/onboard.ts', shouldMatch: true },
      { skillId: 'documentation-generation', path: 'src/utils/helper.ts', shouldMatch: false },
    ];

    it.each(testCases)('$skillId indicator matches $path correctly', ({ skillId, path, shouldMatch }) => {
      const skill = SKILL_CATALOG.find((s) => s.id === skillId);
      expect(skill).toBeDefined();
      const matches = skill!.indicators.some((re) => re.test(path));
      expect(matches).toBe(shouldMatch);
    });
  });

  describe('getSkillById()', () => {
    it('returns correct skill for valid ID', () => {
      const skill = SKILL_CATALOG.find((s) => s.id === 'typescript');
      expect(skill).toBeDefined();
      expect(skill!.label).toBe('TypeScript');
    });

    it('returns undefined for invalid ID', () => {
      const skill = SKILL_CATALOG.find((s) => s.id === 'nonexistent');
      expect(skill).toBeUndefined();
    });

    it('finds each skill by its ID', () => {
      for (const expected of SKILL_CATALOG) {
        const found = SKILL_CATALOG.find((s) => s.id === expected.id);
        expect(found).toBe(expected);
      }
    });
  });

  describe('getSkillIds()', () => {
    it('returns all skill IDs', () => {
      const ids = SKILL_CATALOG.map((s) => s.id);
      expect(ids).toHaveLength(21);
      expect(ids).toContain('typescript');
      expect(ids).toContain('async-patterns');
      expect(ids).toContain('documentation-generation');
    });

    it('returns unique IDs', () => {
      const ids = SKILL_CATALOG.map((s) => s.id);
      const unique = new Set(ids);
      expect(unique.size).toBe(ids.length);
    });
  });

  describe('importance values', () => {
    it('has importance values between 0 and 1', () => {
      for (const skill of SKILL_CATALOG) {
        expect(skill.importance).toBeGreaterThanOrEqual(0);
        expect(skill.importance).toBeLessThanOrEqual(1);
      }
    });

    it('typescript has highest importance', () => {
      const typescript = SKILL_CATALOG.find((s) => s.id === 'typescript')!;
      expect(typescript.importance).toBe(0.9);
    });

    it('license-compliance and documentation-generation have lowest importance', () => {
      const license = SKILL_CATALOG.find((s) => s.id === 'license-compliance')!;
      const docs = SKILL_CATALOG.find((s) => s.id === 'documentation-generation')!;
      expect(license.importance).toBe(0.5);
      expect(docs.importance).toBe(0.5);
    });
  });

  describe('suggested commands', () => {
    it('all skills have at least one suggested command starting with pm', () => {
      for (const skill of SKILL_CATALOG) {
        expect(skill.suggestedCommands.length).toBeGreaterThan(0);
        const hasPmCommand = skill.suggestedCommands.some((cmd) => cmd.startsWith('pm'));
        expect(hasPmCommand).toBe(true);
      }
    });
  });
});
