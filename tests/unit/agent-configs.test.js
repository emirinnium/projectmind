import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildOpencodeConfig, buildProjectMindSkillMd, CLAUDE_SKILL_NAME, CLAUDE_SKILL_RELATIVE_PATH, OPENCODE_CONFIG_FILENAME, writeClaudeSkill, writeOpencodeConfig, inferProjectName, } from '../../src/cli/generators/agent-configs.js';
// ---------------------------------------------------------------------------
// Fixtures — temp project root cleaned up afterwards.
// ---------------------------------------------------------------------------
const FIXTURE_DIR = join(tmpdir(), 'pm-agent-configs-test-' + Date.now());
beforeAll(() => {
    mkdirSync(FIXTURE_DIR, { recursive: true });
});
afterAll(() => {
    rmSync(FIXTURE_DIR, { recursive: true, force: true });
});
describe('buildOpencodeConfig', () => {
    it('is a spec-compliant OpenCode config', () => {
        const cfg = buildOpencodeConfig();
        expect(cfg.$schema).toBe('https://opencode.ai/config.json');
        expect(cfg.mcp.projectmind.type).toBe('local');
        expect(cfg.mcp.projectmind.enabled).toBe(true);
        // OpenCode uses `environment` (NOT `env`) for local server env vars.
        expect(cfg.mcp.projectmind.environment).toEqual({ PROJECTMIND_ROOT: '.' });
        expect(cfg.mcp.projectmind.command).toEqual(['npx', '-y', '@emirhanturker/projectmind@latest', 'mcp']);
    });
    it('scopes the toolset via a tools glob', () => {
        const cfg = buildOpencodeConfig();
        // OpenCode prefixes MCP tool names with `<server>_`, so `projectmind*`
        // surfaces every tool of the projectmind server.
        expect(cfg.tools['projectmind*']).toBe(true);
    });
    it('never uses the legacy mcpServers shape', () => {
        const cfg = buildOpencodeConfig();
        expect('mcpServers' in cfg).toBe(false);
        // Legacy OpenCode entries could pass a STRING command; the spec wants an array.
        expect(typeof cfg.mcp.projectmind.command).not.toBe('string');
        expect(Array.isArray(cfg.mcp.projectmind.command)).toBe(true);
    });
});
describe('buildProjectMindSkillMd', () => {
    const md = buildProjectMindSkillMd();
    it('has valid Claude Code skill frontmatter', () => {
        const lines = md.split('\n');
        expect(lines[0]).toBe('---');
        // Name: lowercase letters/numbers/hyphens only, max 64 chars.
        expect(CLAUDE_SKILL_NAME).toMatch(/^[a-z0-9-]+$/);
        expect(CLAUDE_SKILL_NAME.length).toBeLessThanOrEqual(64);
        expect(lines[1]).toBe(`name: ${CLAUDE_SKILL_NAME}`);
        expect(lines[2].startsWith('description:')).toBe(true);
        // Frontmatter closes with a second `---` line before the body.
        expect(lines[3]).toBe('---');
        // Description must stay on ONE line — wrapped descriptions are silently
        // ignored by Claude Code's skill discovery (anthropics/claude-code#9817).
        const matches = md.match(/^description: (.+)$/m);
        expect(matches).not.toBeNull();
        expect(matches?.[1]).not.toContain('\n');
        // Reserved words (anthropic/claude) are banned in the NAME field only.
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
        // The file already exists from the previous test.
        const before = readFileSync(join(FIXTURE_DIR, CLAUDE_SKILL_RELATIVE_PATH), 'utf-8');
        writeFileSync(join(FIXTURE_DIR, CLAUDE_SKILL_RELATIVE_PATH), '# custom content\n', 'utf-8');
        const result = writeClaudeSkill(FIXTURE_DIR, false);
        expect(result.written).toBe(false);
        expect(result.existed).toBe(true);
        expect(readFileSync(join(FIXTURE_DIR, CLAUDE_SKILL_RELATIVE_PATH), 'utf-8')).toBe('# custom content\n');
        // Restore for cleanliness.
        expect(before.length).toBeGreaterThan(0);
    });
});
describe('writeOpencodeConfig', () => {
    it('writes a spec-compliant opencode.json at the project root', () => {
        const result = writeOpencodeConfig(FIXTURE_DIR, true);
        expect(result.written).toBe(true);
        const full = join(FIXTURE_DIR, OPENCODE_CONFIG_FILENAME);
        expect(result.path).toBe(full);
        const parsed = JSON.parse(readFileSync(full, 'utf-8'));
        expect(parsed.$schema).toBe('https://opencode.ai/config.json');
        const mcp = parsed.mcp;
        expect(mcp.projectmind.type).toBe('local');
        expect(mcp.projectmind.enabled).toBe(true);
    });
    it('merges with an existing opencode.json instead of destroying it', () => {
        const existing = { $schema: 'https://opencode.ai/config.json', model: 'anthropic/claude-sonnet-4' };
        writeFileSync(join(FIXTURE_DIR, OPENCODE_CONFIG_FILENAME), JSON.stringify(existing), 'utf-8');
        const result = writeOpencodeConfig(FIXTURE_DIR, true);
        expect(result.written).toBe(true);
        const parsed = JSON.parse(readFileSync(join(FIXTURE_DIR, OPENCODE_CONFIG_FILENAME), 'utf-8'));
        expect(parsed.model).toBe('anthropic/claude-sonnet-4'); // preserved
        const mcp = parsed.mcp;
        expect(mcp.projectmind.enabled).toBe(true);
    });
});
describe('inferProjectName', () => {
    it('returns the package.json name when present', () => {
        const pkg = join(FIXTURE_DIR, 'package.json');
        const hadPkg = existsSync(pkg);
        const previous = hadPkg ? readFileSync(pkg, 'utf-8') : undefined;
        writeFileSync(pkg, JSON.stringify({ name: '@acme/widget' }), 'utf-8');
        expect(inferProjectName(FIXTURE_DIR)).toBe('@acme/widget');
        if (!hadPkg)
            rmSync(pkg, { force: true });
        else
            writeFileSync(pkg, previous ?? '', 'utf-8');
    });
    it('returns undefined when no package.json exists', () => {
        const empty = join(tmpdir(), 'pm-agent-configs-empty-' + Date.now());
        mkdirSync(empty, { recursive: true });
        expect(inferProjectName(empty)).toBeUndefined();
        rmSync(empty, { recursive: true, force: true });
    });
});
//# sourceMappingURL=agent-configs.test.js.map