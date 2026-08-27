import { describe, it, expect } from 'vitest';
import {
  SKILL_CATALOG,
  analyzeSkillGaps,
  estimateAllProficiencies,
  estimateSkillProficiency,
  extractCodebaseSkills,
  generateSkillDoc,
  type SkillEvidence,
} from '../../src/core/skills/engine.js';

type ModuleLike = Array<{ files?: Array<{ relativePath?: string; language?: string }> }>;

function moduleWith(...paths: string[]): ModuleLike {
  return [
    {
      path: 'mock',
      name: 'mock',
      fileCount: paths.length,
      totalBytes: 0,
      cognitiveLoad: 0,
      agentCoverage: 0,
      files: paths.map((p) => ({ relativePath: p, language: 'typescript' })),
    },
  ];
}

describe('extractCodebaseSkills — repo evidence mapping', () => {
  it('maps real module paths onto skills and drops un-evidenced ones', () => {
    const evidence = extractCodebaseSkills(
      moduleWith('src/parser/structural-search.ts', 'src/parser/structural-search.ts', 'src/core/debt/tracker.ts', 'src/vendor/opaque.js'),
    );

    expect(evidence['ast-parsing']?.files).toEqual(['src/parser/structural-search.ts']); // deduped
    expect(evidence['debt-detection']?.files).toContain('src/core/debt/tracker.ts');
    expect(evidence['embedding-generation']).toBeUndefined(); // no embedding evidence in this repo snapshot
    expect(evidence['vendor-only']).toBeUndefined(); // unknown ids never appear
  });

  it('returns the full catalog when there is no scan data', () => {
    const evidence = extractCodebaseSkills([]);
    expect(Object.keys(evidence)).toHaveLength(SKILL_CATALOG.length);
  });

  it('caps evidence files per skill', () => {
    const many = Array.from({ length: 30 }, (_, i) => `src/parser/file-${i}.ts`);
    const evidence = extractCodebaseSkills(moduleWith(...many));
    expect(evidence['ast-parsing']!.files.length).toBeLessThanOrEqual(8);
  });

  it('never lists the same file twice within a single skill (typescript special branch + indicator loop)', () => {
    const evidence = extractCodebaseSkills(
      moduleWith('src/parser/structural-search.ts', 'src/parser/x.ts', 'vitest.config.ts', 'scripts/generate-logos.ts'),
    );
    for (const [id, skill] of Object.entries(evidence)) {
      const files = skill.files;
      expect(new Set(files).size, `duplicate files for skill ${id}`).toBe(files.length);
    }
    expect(evidence['typescript']?.files).toContain('vitest.config.ts');
    expect(evidence['typescript']?.files).toContain('scripts/generate-logos.ts');
  });
});

describe('estimateSkillProficiency — interaction-history evidence', () => {
  it('stays 0 with zero evidence (never fabricated)', () => {
    expect(
      estimateSkillProficiency(SKILL_CATALOG.find((s) => s.id === 'ast-parsing')!, {
        sessionCount: 0,
        touchedPaths: [],
        decisionsText: '',
        asyncPreference: -1,
      }),
    ).toBe(0);
  });

  it('adds 0.35 per touched file matching the skill signals', () => {
    const skill = SKILL_CATALOG.find((s) => s.id === 'ast-parsing')!;
    const one = estimateSkillProficiency(skill, {
      sessionCount: 0,
      touchedPaths: ['src/parser/language-service.ts'],
      decisionsText: '',
      asyncPreference: -1,
    });
    expect(one).toBeCloseTo(0.35, 5);

    const many = estimateSkillProficiency(skill, {
      sessionCount: 0,
      touchedPaths: [
        'src/parser/a.ts',
        'src/parser/b.ts',
        'src/parser/c.ts',
        'src/parser/d.ts',
      ],
      decisionsText: '',
      asyncPreference: -1,
    });
    expect(many).toBe(1); // capped
  });

  it('adds activity from session count and decisions text', () => {
    const skill = SKILL_CATALOG.find((s) => s.id === 'debt-detection')!;
    const score = estimateSkillProficiency(skill, {
      sessionCount: 10, // → 0.15
      touchedPaths: [],
      decisionsText: JSON.stringify([{ verdict: 'fail', file: '/debt/tracker.ts' }]), // → 0.1
      asyncPreference: -1,
    });
    expect(score).toBeCloseTo(0.25, 5);
  });

  it('boosts async-patterns from the async fingerprint', () => {
    const skill = SKILL_CATALOG.find((s) => s.id === 'async-patterns')!;
    const withFp = estimateSkillProficiency(skill, { sessionCount: 0, touchedPaths: [], decisionsText: '', asyncPreference: 0.9 });
    const withoutFp = estimateSkillProficiency(skill, { sessionCount: 0, touchedPaths: [], decisionsText: '', asyncPreference: -1 });
    expect(withFp).toBeCloseTo(withoutFp + 0.15, 5);
  });

  it('estimates every catalog skill within 0..1', () => {
    const all = estimateAllProficiencies({ sessionCount: 1, touchedPaths: ['src/mcp-server.ts'], decisionsText: 'x', asyncPreference: 0.5 });
    expect(Object.keys(all)).toHaveLength(SKILL_CATALOG.length);
    for (const v of Object.values(all)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

function evidenceWith(...skills: string[]): Record<string, SkillEvidence> {
  const map: Record<string, SkillEvidence> = {};
  for (const s of skills) {
    const def = SKILL_CATALOG.find((d) => d.id === s)!;
    map[s] = { id: s, description: def.description, whyItHelps: def.whyItHelps, importance: def.importance, files: [], suggestedCommands: def.suggestedCommands };
  }
  return map;
}

describe('analyzeSkillGaps', () => {
  it('reports gaps above the threshold, sorted by size', () => {
    const gaps = analyzeSkillGaps({ 'ast-parsing': 0, 'mcp-protocol': 1 }, evidenceWith('ast-parsing', 'mcp-protocol'), 0.3);
    expect(gaps.map((g) => g.skill)).toEqual(['ast-parsing']);
    expect(gaps[0].gap).toBeCloseTo(0.7, 5);
    expect(gaps[0].priority).toBe('high'); // gap > 0.4, importance 0.7 (not > 0.8)
  });

  it('marks typescript gaps as critical', () => {
    const gaps = analyzeSkillGaps({ typescript: 0 }, evidenceWith('typescript'), 0.3);
    expect(gaps[0].priority).toBe('critical'); // gap 0.9 > 0.5 AND importance 0.9 > 0.8
  });

  it('keeps gaps under the threshold out of the report', () => {
    const gaps = analyzeSkillGaps({ 'ast-parsing': 0.6 }, evidenceWith('ast-parsing'), 0.3);
    expect(gaps).toHaveLength(0);
  });

  it('computes estimated effort from the gap size', () => {
    const gaps = analyzeSkillGaps({ 'ast-parsing': 0 }, evidenceWith('ast-parsing'), 0.3);
    expect(gaps[0].estimatedHours).toBe(Math.ceil(0.7 * 20));
  });
});

describe('generateSkillDoc — personalized SKILL.md', () => {
  const gaps = analyzeSkillGaps({ 'ast-parsing': 0 }, evidenceWith('ast-parsing', 'typescript'), 0.1);

  const doc = generateSkillDoc({
    agentName: 'kilo-code',
    sessionCount: 12,
    filesTouchedCount: 34,
    fingerprint: { asyncPreference: 0.8, typeAssertionUsage: 0.1, errorHandlingStyle: 'try-catch', namingConvention: 'camelCase' },
    touchedPaths: ['src/parser/language-service.ts', 'src/auth/registry.ts'],
    gaps,
    generatedAt: '2026-08-27T00:00:00.000Z',
  });

  it('is valid markdown with frontmatter and identity', () => {
    expect(doc.startsWith('---\nname: kilo-code')).toBe(true);
    expect(doc).toContain('# kilo-code — Personalized Agent Skill');
    expect(doc).toContain('12 recorded session(s)');
  });

  it('explains what each skill helps with and the commands to apply it', () => {
    expect(doc).toContain('**What it helps with:**');
    expect(doc).toContain('`pm taint`'); // ast-parsing suggested command
    expect(doc).toContain('**Suggested commands:**');
  });

  it('reflects the measured fingerprint without fabrications', () => {
    expect(doc).toContain('Async preference: 80%');
    expect(doc).toContain('Error handling: try-catch');
    expect(doc).not.toContain('undefined');
    expect(doc).not.toContain('NaN');
  });

  it('mentions the most recent touched files', () => {
    expect(doc).toContain('src/auth/registry.ts');
  });
});