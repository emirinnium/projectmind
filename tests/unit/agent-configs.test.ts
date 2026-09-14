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
import {
  mergeCodexConfig,
  mergeProjectMindInstructions,
  writeMcpConfig,
  verifyMcpConfig,
  type AgentKind,
} from '../../src/cli/commands/init-mcp-config.js';
import { resolveAgentConfigPath } from '../../src/cli/commands/init-mcp.js';

const FIXTURE_DIR = join(tmpdir(), 'pm-agent-configs-test-' + Date.now());

beforeAll(() => {
  mkdirSync(FIXTURE_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

describe('buildProjectMindSkillMd', () => {
  const md = buildProjectMindSkillMd('projectmind');

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
    for (const tool of [
      'get_context',
      'analyze_impact',
      'check_coherence',
      'debt_report',
      'find_circular_deps',
      'genome_score',
      'store_memory',
      'run_cli',
    ]) {
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
    expect(readFileSync(join(FIXTURE_DIR, CLAUDE_SKILL_RELATIVE_PATH), 'utf-8')).toBe(
      '# custom content\n',
    );
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

describe('MCP initialization config merging', () => {
  it('reuses existing OpenCode/Kilo JSONC or JSON config variants', () => {
    const opencodeJsonc = join(FIXTURE_DIR, 'opencode.jsonc');
    writeFileSync(opencodeJsonc, '{}', 'utf8');
    expect(resolveAgentConfigPath(FIXTURE_DIR, 'opencode', 'opencode.json')).toBe(opencodeJsonc);

    const kiloJson = join(FIXTURE_DIR, '.kilo', 'kilo.json');
    mkdirSync(join(FIXTURE_DIR, '.kilo'), { recursive: true });
    writeFileSync(kiloJson, '{}', 'utf8');
    expect(resolveAgentConfigPath(FIXTURE_DIR, 'kilo-code', '.kilo/kilo.jsonc')).toBe(kiloJson);
  });

  it('preserves existing agent instructions and never appends a duplicate block', () => {
    const first = mergeProjectMindInstructions('# Team instructions\n', 'opencode', false);
    expect(first.changed).toBe(true);
    expect(first.content).toContain('# Team instructions');
    expect(first.content.match(/projectmind:mcp-instructions:start/g)).toHaveLength(1);

    const second = mergeProjectMindInstructions(first.content, 'opencode', false);
    expect(second.changed).toBe(false);
    expect(second.content).toBe(first.content);

    const forced = mergeProjectMindInstructions(first.content, 'kilo-code', true);
    expect(forced.changed).toBe(true);
    expect(forced.content).toContain('# ProjectMind instructions (kilo-code)');
    expect(forced.content.match(/projectmind:mcp-instructions:start/g)).toHaveLength(1);
    expect(forced.content).toContain('# Team instructions');
  });

  it('updates a marked Codex block without duplicating or deleting other TOML tables', () => {
    const current = [
      '[other]',
      'value = 1',
      '',
      '[mcp_servers.projectmind]',
      'command = "old"',
      'args = []',
      '',
      '[extra]',
      'value = 2',
      '',
    ].join('\n');
    const result = mergeCodexConfig(current, FIXTURE_DIR, true);
    expect(result.changed).toBe(true);
    expect(result.content.match(/\[mcp_servers\.projectmind\]/g)).toHaveLength(1);
    expect(result.content).toContain('[other]');
    expect(result.content).toContain('[extra]');
    expect(result.content).toContain('PROJECTMIND_ROOT');
  });

  it('reads JSONC comments/trailing commas without corrupting string values', () => {
    const path = join(FIXTURE_DIR, 'kilo.jsonc');
    writeFileSync(
      path,
      '{\n  // keep this unrelated server\n  "mcp": { "other": { "label": "value,}" }, },\n}\n',
      'utf8',
    );
    expect(writeMcpConfig(path, FIXTURE_DIR, 'kilo', false)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      mcp: { other: { label: string }; projectmind: { environment: { PROJECTMIND_ROOT: string } } };
    };
    expect(parsed.mcp.other.label).toBe('value,}');
    expect(parsed.mcp.projectmind.environment.PROJECTMIND_ROOT).toBe(FIXTURE_DIR);
  });

  it('merges OpenCode v2 config and is idempotent on repeat runs', () => {
    const path = join(FIXTURE_DIR, 'opencode.json');
    writeFileSync(path, JSON.stringify({ mcp: { servers: { other: { type: 'local' } } } }), 'utf8');

    expect(writeMcpConfig(path, FIXTURE_DIR, 'opencode', false)).toBe(true);
    expect(writeMcpConfig(path, FIXTURE_DIR, 'opencode', false)).toBe(false);

    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      mcp: {
        servers: {
          other: { type: string };
          projectmind: {
            type: string;
            cwd: string;
            disabled: boolean;
            environment: { PROJECTMIND_ROOT: string };
          };
        };
      };
    };
    expect(parsed.mcp.servers.other.type).toBe('local');
    expect(parsed.mcp.servers.projectmind.type).toBe('local');
    expect(parsed.mcp.servers.projectmind.cwd).toBe(FIXTURE_DIR);
    expect(parsed.mcp.servers.projectmind.disabled).toBe(false);
    expect(parsed.mcp.servers.projectmind.environment.PROJECTMIND_ROOT).toBe(FIXTURE_DIR);
  });

  it('verifies every supported MCP transport shape used by the agent profiles', () => {
    const matrix: Array<{ kind: AgentKind; file: string }> = [
      { kind: 'json-mcp', file: 'matrix-json-mcp.json' },
      { kind: 'portable', file: 'matrix-portable.json' },
      { kind: 'opencode', file: 'matrix-opencode.json' },
      { kind: 'kilo', file: 'matrix-kilo.jsonc' },
      { kind: 'codex', file: 'matrix-codex.toml' },
    ];
    const matrixRoot = join(FIXTURE_DIR, 'matrix');
    mkdirSync(matrixRoot, { recursive: true });
    for (const item of matrix) {
      const path = join(matrixRoot, item.file);
      expect(writeMcpConfig(path, FIXTURE_DIR, item.kind, false)).toBe(true);
      const verification = verifyMcpConfig(path, FIXTURE_DIR, item.kind);
      expect(verification.ok, item.kind).toBe(true);
      expect(verification.projectmindEntry).toBe(true);
      expect(verification.duplicateProjectMindEntries).toBe(0);
      expect(
        verification.checks.find((check) => check.name === 'project-root')?.status,
        item.kind,
      ).toBe('pass');
    }
  });

  it('verifies the exact structural entry and detects duplicate raw keys', () => {
    const path = join(FIXTURE_DIR, 'verify.json');
    writeFileSync(path, '{}', 'utf8');
    expect(writeMcpConfig(path, FIXTURE_DIR, 'json-mcp', false)).toBe(true);
    const valid = verifyMcpConfig(path, FIXTURE_DIR, 'json-mcp');
    expect(valid.ok).toBe(true);
    expect(valid.duplicateProjectMindEntries).toBe(0);

    writeFileSync(
      path,
      '{"mcpServers":{"projectmind":{"command":"npx"},"projectmind":{"command":"npx"}}}',
      'utf8',
    );
    const duplicate = verifyMcpConfig(path, FIXTURE_DIR, 'json-mcp');
    expect(duplicate.duplicateProjectMindEntries).toBe(1);
    expect(duplicate.checks.find((check) => check.name === 'duplicate-entry')?.status).toBe('warn');
  });
});
