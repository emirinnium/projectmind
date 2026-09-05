import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Claude Code SKILL.md
// ---------------------------------------------------------------------------

export const CLAUDE_SKILL_NAME = 'projectmind-codebase-intelligence';
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
| \`search\` | Find code patterns using AST matching |
| \`store_memory\` / \`memory_get\` / \`run_cli\` | Persist and retrieve project knowledge |
| \`graph\` | Full dependency graph visualization |

## How to use

1. Run \`projectmind scan\` to build the knowledge graph
2. Run \`projectmind get-context <file>\` before editing
3. Run \`projectmind analyze-impact <file>\` before changing
4. Run \`projectmind coherence\` after edits
5. Run \`projectmind debt\` before commits
6. Run \`projectmind genome\` for overall health
7. Run \`projectmind circular\` to check for cycles
8. Use \`projectmind memory-store\` and \`projectmind memory-get\` for persistence

## Rules

- Always check impact before modifying files
- Use get_context on every file read
- Run coherence after every edit
- Check debt before every commit
- Never introduce circular dependencies
- Use memory to persist insights across sessions
`;

export function buildProjectMindSkillMd(description: string): string {
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
// Disk writers
// ---------------------------------------------------------------------------

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

export function writeClaudeSkill(root: string, force: boolean): WriteResult {
  const target = join(root, CLAUDE_SKILL_RELATIVE_PATH);
  const existed = existsSync(target);
  if (existed && !force) return { path: target, written: false, existed };
  mkdirSync(join(root, '.claude', 'skills', CLAUDE_SKILL_NAME), { recursive: true });
  writeFileSync(target, buildProjectMindSkillMd(inferProjectName(root) ?? 'projectmind'), 'utf-8');
  return { path: target, written: true, existed };
}
