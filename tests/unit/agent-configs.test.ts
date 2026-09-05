import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildProjectMindSkillMd,
  CLAUDE_SKILL_NAME,
  CLAUDE_SKILL_RELATIVE_PATH,
  writeClaudeSkill,
  inferProjectName,
} from '../../src/cli/generators/agent-configs.js';

const FIXTURE_DIR = join(tmpdir(), 'pm-agent-configs-test-' + Date.now());

beforeAll(() => {
  mkdirSync(FIXTURE_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

describe('buildProjectMindSkillMd', () => {
  const md = buildProjectMindSkillMd();

  it('has valid Claude Code skill frontmatter', () => {
    const lines = md.split('\n');
    expect(lines[0]).toBe('---');
    expect(CLAUDE_SKILL_NAME).toMatch(/^[a-z0-9-]+$/);
    expect(CLAUDE_SKILL_NAME.length).toBeLessThanOrEqual(64);
    expect(lines[1]).toBe(`name: ${CLAUDE_SKILL_NAME}`);
    expect(lines[2].startsWith('description:')).toBe(true);
    expect(lines[3]).toBe('---');
    const matches = md.match(/^description: (.+)$/m);
    expect(matches).not.toBeNull();
    expect(matches?.[1]).not.toContain('\n');
    expect(lines[1]).not.toContain('anthropic');
    expect(lines[1]).not.toContain('claude');
  });

  it('introduces ProjectMind core tools in the body', () => {
    for (const tool of ['get_context', 'analyze_impact', 'check_coherence', 'debt_report', 'find_circular_deps', 'genome_score', 'store_memory', 'run_cli']) {
      expect(md).toContain(tool);
    }
  });

  it('injects the project name when provided', () => {
    const personalized = buildProjectMindSkillMd('@acme/widget');
    expect(personalized).toContain('@acme/widget');
  });
});

describe('writeClaudeSkill', () => {
  it('writes .claude/skills/<name>/SKILL.md', () => {
    const result = writeClaudeSkill(FIXTURE_DIR, true);
    expect(result.written).toBe(true);
    const full = join(FIXTURE_DIR, CLAUDE_SKILL_RELATIVE_PATH);
    expect(result.path).toBe(full);
    expect(existsSync(full)).toBe(true);
    const content = readFileSync(full, 'utf-8');
    expect(content.startsWith('---\n')).toBe(true);
    expect(content).toContain(`name: ${CLAUDE_SKILL_NAME}`);
  });

  it('does not overwrite when force=false', () => {
    const before = readFileSync(join(FIXTURE_DIR, CLAUDE_SKILL_RELATIVE_PATH), 'utf-8');
    writeFileSync(join(FIXTURE_DIR, CLAUDE_SKILL_RELATIVE_PATH), '# custom content\n', 'utf-8');
    const result = writeClaudeSkill(FIXTURE_DIR, false);
    expect(result.written).toBe(false);
    expect(result.existed).toBe(true);
    expect(readFileSync(join(FIXTURE_DIR, CLAUDE_SKILL_RELATIVE_PATH), 'utf-8')).toBe('# custom content\n');
    expect(before.length).toBeGreaterThan(0);
  });
});

describe('inferProjectName', () => {
  it('returns the package.json name when present', () => {
    const pkg = join(FIXTURE_DIR, 'package.json');
    const hadPkg = existsSync(pkg);
    const previous = hadPkg ? readFileSync(pkg, 'utf-8') : undefined;
    writeFileSync(pkg, JSON.stringify({ name: '@acme/widget' }), 'utf-8');
    expect(inferProjectName(FIXTURE_DIR)).toBe('@acme/widget');
    if (!hadPkg) rmSync(pkg, { force: true });
    else writeFileSync(pkg, previous ?? '', 'utf-8');
  });

  it('returns undefined when no package.json exists', () => {
    const empty = join(tmpdir(), 'pm-agent-configs-empty-' + Date.now());
    mkdirSync(empty, { recursive: true });
    expect(inferProjectName(empty)).toBeUndefined();
    rmSync(empty, { recursive: true, force: true });
  });
});
