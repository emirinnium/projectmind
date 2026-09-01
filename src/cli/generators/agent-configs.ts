/**
 * Agent config generators for Faz 3 — native recognition by external clients.
 *
 * Two generators live here (kept free of CLI I/O so they are unit-testable):
 *
 * 1. `buildProjectMindSkillMd()` — a Claude Code SKILL.md that lives at
 *    `.claude/skills/<name>/SKILL.md` and introduces ProjectMind's core MCP
 *    tools into Claude Code's capability set (frontmatter `name` + `description`
 *    are the only required fields; the body is the skill instructions).
 *
 * 2. `buildOpencodeConfig()` — a spec-compliant OpenCode `opencode.json`
 *    (OpenCode's 2026 config schema, NOT the legacy `.opencode/mcp.json`):
 *    `$schema`, local server entry with `environment`, `enabled: true`, and
 *    toolset scoping through a `tools` glob that surfaces every
 *    `<server>_<tool>` name from the `projectmind` MCP server.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Claude Code SKILL.md
// ---------------------------------------------------------------------------

/**
 * Skill directory name. Claude Code requires: max 64 chars, lowercase letters,
 * numbers and hyphens only. `/projectmind-codebase-intelligence` becomes the
 * slash-command path once loaded.
 */
export const CLAUDE_SKILL_NAME = 'projectmind-codebase-intelligence';

/** Relative path (from the project root) of the generated skill file. */
export const CLAUDE_SKILL_RELATIVE_PATH = join('.claude', 'skills', CLAUDE_SKILL_NAME, 'SKILL.md');

const SKILL_BODY = `# ProjectMind Codebase Intelligence

You have a live knowledge graph of this repository through the ProjectMind MCP
server (\`mcpServers.projectmind\`). Its tools are not optional — they are your
eyes into architecture, dependencies, debt, and history. Use them PROACTIVELY.

## Core tools

| Tool | Use when |
| ---- | -------- |
| \`get_context\` | Before reading or editing a file: imports, dependents, structure, similar patterns |
| \`analyze_impact\` | You need the blast radius of a planned change before touching code |
| \`check_coherence\` | After every edit: verifies your change matches project patterns |
| \`debt_report\` | Before a commit: high-severity items are release blockers |
| \`find_circular_deps\` | Before a commit: no new import cycles may be introduced |
| \`genome_score\` | Overall project health score (aim for ≥ 70) |
| \`store_memory\` / \`get_memory\` | Persist and retrieve cross-session decisions |
| \`run_cli\` | Anything without a dedicated tool: \`["doctor","scan-health"]\`, \`["churn","--since","30"]\`, \`["audit"]\`, \`["sbom"]\` |

## Workflow rules

### 1. Before reading or editing any file
Call \`get_context { filePath }\` first, then \`analyze_impact { filePath }\`.
Never guess about codebase state — query the graph.

### 2. After every edit
Call \`check_coherence { code: <new content>, filePath: <path>, fastOnly: true }\`.
If the verdict is \`warn\` or \`fail\`, read the suggestions and fix before
proceeding to the next step.

### 3. Before suggesting or making a commit
Call \`debt_report {}\` (high-severity items must be 0),
\`find_circular_deps {}\` (no new cycles), \`genome_score {}\` (≥ 70), and
\`run_cli { args: ["doctor","scan-health"] }\` for a full health sweep.

### 4. When creating new files
Call \`scan_project { root: "." }\` to register the file in the knowledge graph,
then \`get_context { filePath }\` on the new file to find similar patterns.

### 5. Cross-session memory
Store important decisions with \`store_memory { scope: "decisions", key: "<topic>", value: "<decision+reason>" }\`.
Retrieve them with \`get_memory { scope: "decisions" }\` when revisiting files.

## Golden rules
- NEVER guess about codebase state — always query the graph first.
- ALWAYS coherence-check after edits — warnings are blockers.
- HIGH severity debt items are release blockers.
- Store decisions — the next session needs them.
`;

/**
 * Build the full SKILL.md document. `projectName` (when known) is injected into
 * the description so the skill reads as personalized to this repository.
 *
 * NOTE: the description must stay on a SINGLE line — Claude Code's skill
 * discovery silently ignores frontmatter whose `description` wraps across
 * multiple lines (see anthropics/claude-code#9817). Keep it under the 1024
 * char limit.
 */
export function buildProjectMindSkillMd(projectName?: string): string {
  const base =
    'Live codebase intelligence for Claude Code via ProjectMind MCP tools. ' +
    'Use when exploring architecture, dependencies, technical debt, refactoring ' +
    'impact, or any question about how this project fits together.';
  const description = projectName ? `${base} Project: ${projectName}.` : base;

  return [
    '---',
    `name: ${CLAUDE_SKILL_NAME}`,
    `description: ${description}`,
    '---',
    '',
    SKILL_BODY,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// OpenCode config (opencode.json)
// ---------------------------------------------------------------------------

export type OpenCodeMcpServerConfig = {
  type: 'local';
  command: string[];
  enabled: boolean;
  environment: Record<string, string>;
};

export type OpenCodeConfig = {
  $schema: string;
  mcp: Record<string, OpenCodeMcpServerConfig>;
  tools: Record<string, boolean>;
};

/** Project-root config file OpenCode reads (spec-compliant 2026 format). */
export const OPENCODE_CONFIG_FILENAME = 'opencode.json';

const OPENCODE_SCHEMA_URL = 'https://opencode.ai/config.json';

/**
 * Build a spec-compliant `opencode.json` (see https://opencode.ai/docs/config/
 * and /docs/mcp-servers/). Key spec points honored here:
 * - `environment` (NOT `env`) for local server environment variables.
 * - `enabled: true` so the server starts up automatically.
 * - `tools` glob scoping so every `projectmind_*` tool (OpenCode prefixes MCP
 *   tool names with `<server>_`) is explicitly enabled for the toolset.
 */
export function buildOpencodeConfig(): OpenCodeConfig {
  return {
    $schema: OPENCODE_SCHEMA_URL,
    mcp: {
      projectmind: {
        type: 'local',
        command: ['npx', '-y', '@emirhanturker/projectmind@latest', 'mcp'],
        enabled: true,
        environment: { PROJECTMIND_ROOT: '.' },
      },
    },
    tools: { 'projectmind*': true },
  };
}

// ---------------------------------------------------------------------------
// Disk writers (small, shared by the CLI command and tests)
// ---------------------------------------------------------------------------

/** Infer a repository name from `<root>/package.json` (best-effort). */
export function inferProjectName(root: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as { name?: unknown };
    return typeof pkg.name === 'string' && pkg.name.length > 0 ? pkg.name : undefined;
  } catch {
    return undefined;
  }
}

export interface WriteResult {
  path: string;
  written: boolean;
  existed: boolean;
}

/**
 * Write `.claude/skills/<name>/SKILL.md` inside `root`. Returns info about what
 * happened so the CLI can print a useful message. `force=false` keeps existing
 * files untouched (like the rest of init-mcp).
 */
export function writeClaudeSkill(root: string, force: boolean): WriteResult {
  const target = join(root, CLAUDE_SKILL_RELATIVE_PATH);
  const existed = existsSync(target);
  if (existed && !force) return { path: target, written: false, existed };
  mkdirSync(join(root, '.claude', 'skills', CLAUDE_SKILL_NAME), { recursive: true });
  writeFileSync(target, buildProjectMindSkillMd(inferProjectName(root)), 'utf-8');
  return { path: target, written: true, existed };
}

/**
 * Write a spec-compliant `opencode.json` inside `root`. Merges with an existing
 * file by replacing only its `mcp.projectmind` + `tools` keys, preserving any
 * other OpenCode settings the developer may have configured.
 */
export function writeOpencodeConfig(root: string, force: boolean): WriteResult {
  const target = join(root, OPENCODE_CONFIG_FILENAME);
  const existed = existsSync(target);
  const fresh = buildOpencodeConfig();

  if (existed && !force) return { path: target, written: false, existed };

  let merged = fresh;
  if (existed) {
    try {
      const existing = JSON.parse(readFileSync(target, 'utf-8')) as Record<string, unknown>;
      if (existing !== null && typeof existing === 'object') {
        merged = {
          $schema: OPENCODE_SCHEMA_URL,
          ...existing,
          mcp: { ...(existing.mcp as Record<string, unknown> | undefined), ...fresh.mcp },
          tools: { ...(existing.tools as Record<string, unknown> | undefined), ...fresh.tools },
        } as OpenCodeConfig;
      }
    } catch {
      // Corrupt existing file → fall back to the fresh config.
    }
  }

  writeFileSync(target, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
  return { path: target, written: true, existed };
}
