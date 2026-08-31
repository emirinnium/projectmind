import { describe, it, expect } from 'vitest';
import { recommendSkillsForTool } from '../../../src/mcp/tools/skill-recommend.js';
import { SKILL_CATALOG } from '../../../src/core/skills/engine.js';
import type { McpDependencies } from '../../../src/mcp/tools/types.js';

/**
 * Minimal McpDependencies stub — recommendSkillsForTool only relies on the
 * OPTIONAL `deps.scale` (repo-evidence boost), so a bare projectRoot stub
 * exercises the catalog-only ranking path deterministically.
 */
function makeDeps(projectRoot: string): McpDependencies {
  return { projectRoot } as McpDependencies;
}

describe('recommend_skills (recommendSkillsForTool)', () => {
  it('ranks security-auditing first for a security task', () => {
    const result = recommendSkillsForTool(makeDeps('/test'), {
      task: 'audit the auth token handling for leaked secrets and taint flows',
    });

    expect(result.task).toBe('audit the auth token handling for leaked secrets and taint flows');
    expect(result.totalSkillsConsidered).toBe(SKILL_CATALOG.length);
    expect(result.recommendations.length).toBeGreaterThan(0);

    const top = result.recommendations[0];
    expect(top).toMatchObject({
      id: 'security-auditing',
      name: 'Security auditing',
    });
    // Spec shape: every item carries name/description/score/reason.
    expect(typeof top.description).toBe('string');
    expect(top.description.length).toBeGreaterThan(0);
    expect(top.score).toBeGreaterThan(0);
    expect(top.reason).toContain('task mentions');
    expect(top.suggestedCommands).toContain('pm audit');
  });

  it('returns ranked, monotonically non-increasing scores', () => {
    const result = recommendSkillsForTool(makeDeps('/test'), {
      task: 'migrate the sqlite schema and add vitest unit tests for the database migration',
    });

    expect(result.recommendations.length).toBeGreaterThan(1);
    for (let i = 1; i < result.recommendations.length; i++) {
      expect(result.recommendations[i].score).toBeLessThanOrEqual(result.recommendations[i - 1].score);
    }
    const ids = result.recommendations.map((r) => r.id);
    expect(ids).toContain('sqlite-persistence');
    expect(ids).toContain('testing-patterns');
  });

  it('respects the limit option', () => {
    const result = recommendSkillsForTool(makeDeps('/test'), { task: 'typescript testing and sqlite migration', limit: 2 });

    expect(result.recommendations).toHaveLength(2);
  });

  it('matches every item to a real catalog entry (name/description come from the registry)', () => {
    const result = recommendSkillsForTool(makeDeps('/test'), { task: 'add vitest unit tests with mocks for the cli' });

    for (const rec of result.recommendations) {
      const def = SKILL_CATALOG.find((d) => d.id === rec.id);
      expect(def).toBeDefined();
      expect(rec.name).toBe(def!.label);
      expect(rec.description).toBe(def!.description);
      expect(rec.suggestedCommands).toEqual(def!.suggestedCommands);
      expect(rec.resources).toEqual(def!.resources);
    }
  });

  it('falls back to importance-ranked recommendations for a generic task with no token hits', () => {
    const result = recommendSkillsForTool(makeDeps('/test'), { task: 'zzz qqq generic' });

    // No skill text matches 'zzz'/'qqq'/'generic' — only importance-based
    // recommendations survive the MIN_SCORE gate, and their reasons explain
    // the fallback instead of listing matched terms.
    for (const rec of result.recommendations) {
      expect(rec.reason).toContain('broadly useful');
    }
  });

  it('falls back to importance-ranked recommendations for uninformative task text', () => {
    // 'x' tokenizes to nothing — no skill can match, so the fallback returns
    // importance-ranked catalog skills rather than a useless empty list.
    const result = recommendSkillsForTool(makeDeps('/test'), { task: 'x' });

    expect(result.recommendations.length).toBeGreaterThan(0);
    expect(result.recommendations.length).toBeLessThanOrEqual(5);
    for (const rec of result.recommendations) {
      expect(rec.reason).toContain('broadly useful');
    }
  });

  it('throws for an empty task description', () => {
    expect(() => recommendSkillsForTool(makeDeps('/test'), { task: '   ' })).toThrow(/non-empty task description/i);
  });
});
