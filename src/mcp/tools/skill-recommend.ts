import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpDependencies } from './types.js';
import {
  SKILL_CATALOG,
  extractCodebaseSkills,
  type SkillDefinition,
  type SkillEvidence,
} from '@/core/skills/engine.js';

/**
 * recommend_skills — recommend the most relevant skills from the skills
 * registry for a given task description.
 *
 * The skills engine (src/core/skills/engine.ts) exposes the skill registry as
 * `SKILL_CATALOG` (id/label/description/whyItHelps/importance) plus repo-level
 * evidence via `extractCodebaseSkills(scaleReport.modules)`. It has no direct
 * task→skill primitive (its `analyzeSkillGaps` ranks AGENT proficiency gaps
 * against the repo, not task relevance), so this tool adds a deterministic
 * lexical scorer on top of the registry:
 *
 *   1. Task tokens are matched against each skill's label, description and
 *      whyItHelps text (token overlap, with exact keyword hits weighted
 *      higher than substring hits).
 *   2. Skills evidenced in THIS repo (via the scale report) get a boost, and
 *      their evidence is surfaced in the reason string.
 *   3. Importance (target proficiency) acts as a light tiebreaker so broadly
 *      useful skills surface first when the task text is generic.
 *
 * Deterministic for a fixed input + knowledge-graph snapshot — no LLM, no
 * network, no embedding provider required.
 */

/** Input accepted by the recommend_skills tool. */
export interface RecommendSkillsArgs {
  /** Free-text description of the task ("add rate limiting to the login endpoint"). */
  task: string;
  /** Maximum number of recommendations to return (default 5). */
  limit?: number;
}

/** A single ranked skill recommendation. */
export interface SkillRecommendation {
  /** Skill label from the registry (e.g. "Security auditing"). */
  name: string;
  /** Registry description of what the skill covers. */
  description: string;
  /** Relevance score for this task (0..1, higher = more relevant). */
  score: number;
  /** Why this skill is recommended for the given task. */
  reason: string;
  /** Skill id from the registry (e.g. "security-auditing"). */
  id: string;
  /** CLI commands that exercise this skill in this project. */
  suggestedCommands: string[];
  /** Learning resources attached to the skill. */
  resources: string[];
}

/** Result of a recommend_skills run. */
export interface RecommendSkillsResult {
  task: string;
  recommendations: SkillRecommendation[];
  totalSkillsConsidered: number;
  note: string;
}

/**
 * Extra task→skill keyword hints. Skills whose domain vocabulary does not
 * appear verbatim in label/description text still need to be reachable from
 * natural task descriptions ("auth token handling" → security-auditing).
 */
const TASK_KEYWORD_HINTS: Record<string, string[]> = {
  typescript: ['types', 'typing', 'generics', 'interface', 'typecheck', 'ts'],
  'async-patterns': ['async', 'await', 'promise', 'retry', 'concurrency', 'race', 'rejection'],
  'dependency-injection': ['di', 'injection', 'container', 'service', 'factory', 'wire'],
  'architectural-contracts': ['contract', 'boundary', 'layer', 'forbidden', 'import rules'],
  'coherence-checking': ['coherence', 'quality gate', 'pattern consistency'],
  'debt-detection': ['debt', 'redundancy', 'drift', 'duplication'],
  'embedding-generation': ['embedding', 'vector', 'similarity', 'semantic search'],
  'ast-parsing': ['ast', 'parse', 'parser', 'tree-sitter', 'syntax', 'codemod'],
  'knowledge-graph': ['graph', 'import', 'index', 'circular', 'pagerank', 'kg'],
  'sqlite-persistence': ['sqlite', 'database', 'schema', 'migration', 'query', 'sql'],
  'mcp-protocol': ['mcp', 'tool', 'server', 'protocol', 'transport'],
  'llm-integration': ['llm', 'prompt', 'model', 'provider', 'ai', 'deep analysis'],
  'cli-design': ['cli', 'command', 'commander', 'flag', 'output format'],
  'testing-patterns': ['test', 'vitest', 'mock', 'spec', 'coverage', 'unit test'],
  'security-auditing': ['security', 'audit', 'secret', 'taint', 'owasp', 'auth', 'token', 'crypto'],
  'license-compliance': ['license', 'spdx', 'sbom', 'compliance', 'dependency'],
  'architecture-analysis': [
    'architecture',
    'coupling',
    'cohesion',
    'impact',
    'refactor roi',
    'design',
  ],
  'agent-session-management': ['session', 'memory', 'agent', 'context sharing'],
  'pattern-extraction': ['pattern', 'dedup', 'clone', 'mining'],
  'refactoring-automation': ['refactor', 'rewrite', 'transform', 'codemod', 'organize imports'],
  'documentation-generation': ['docs', 'documentation', 'readme', 'adr', 'docgen', 'onboarding'],
};

/** Minimum relevance for a skill to be recommended (0..1). */
const MIN_SCORE = 0.15;

/** Generic prose words that must never count as task→skill matches. */
const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'are',
  'with',
  'this',
  'that',
  'from',
  'into',
  'here',
  'was',
  'were',
  'has',
  'have',
  'had',
  'will',
  'would',
  'should',
  'could',
  'what',
  'when',
  'where',
  'which',
  'why',
  'how',
  'than',
  'very',
  'just',
  'not',
  'but',
  'can',
  'need',
  'needs',
  'new',
  'use',
  'using',
  'before',
  'after',
  'some',
  'any',
  'all',
  'other',
  'more',
  'most',
  'you',
  'your',
]);

/**
 * Tokenize text into lowercase words, dropping stopwords and tokens shorter
 * than 3 chars (mirrors the smart-assembler's task tokenizer plus a
 * stopword list so prose filler never inflates skill relevance).
 */
function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9_-]+/)
      .filter((t) => t.length >= 3 && !STOPWORDS.has(t)),
  );
}

/** Split the hint phrase lists into token sets once per skill. */
function hintTokens(id: string): Set<string> {
  const hints = TASK_KEYWORD_HINTS[id] ?? [];
  const tokens = new Set<string>();
  for (const h of hints) {
    for (const t of h
      .toLowerCase()
      .split(/[^a-z0-9_-]+/)
      .filter((x) => x.length >= 2)) {
      tokens.add(t);
    }
  }
  return tokens;
}

/** All searchable tokens for one skill (label + description + whyItHelps). */
function skillTokens(skill: SkillDefinition): Set<string> {
  const tokens = new Set<string>();
  for (const text of [skill.label, skill.description, skill.whyItHelps]) {
    for (const t of tokenize(text)) tokens.add(t);
  }
  return tokens;
}

/**
 * Score one skill against the task token set.
 *
 * Signals (deterministic, additive, capped at 1):
 *   - token overlap with the skill's own text (up to 0.6)
 *   - token overlap with the skill's keyword hints (up to 0.25)
 *   - repo evidence for this skill (up to 0.1)
 *   - importance tiebreaker (up to 0.05)
 */
function scoreSkill(
  skill: SkillDefinition,
  taskTokens: Set<string>,
  hasRepoEvidence: boolean,
): { score: number; matchedTerms: string[] } {
  const skillTextTokens = skillTokens(skill);
  const hints = hintTokens(skill.id);

  const matchedTerms = new Set<string>();
  let textHits = 0;
  for (const tok of taskTokens) {
    if (skillTextTokens.has(tok)) {
      textHits++;
      matchedTerms.add(tok);
    }
  }

  let hintHits = 0;
  for (const tok of taskTokens) {
    if (hints.has(tok)) {
      hintHits++;
      matchedTerms.add(tok);
    }
  }

  // Diminishing returns: the first hit is worth most, later hits add less.
  const textScore = Math.min(0.6, textHits === 0 ? 0 : 0.25 + (textHits - 1) * 0.08);
  const hintScore = Math.min(0.25, hintHits === 0 ? 0 : 0.15 + (hintHits - 1) * 0.05);
  const evidenceScore = hasRepoEvidence ? 0.1 : 0;
  const importanceScore = skill.importance * 0.05;

  const score = Math.min(1, textScore + hintScore + evidenceScore + importanceScore);
  return { score, matchedTerms: [...matchedTerms] };
}

/**
 * Recommend the most relevant skills from the skills registry for a task.
 *
 * Pure and dependency-light: only `deps.scale` (OPTIONAL — the repo-evidence
 * boost is skipped when absent) is read, so the function is directly
 * unit-testable with a partial deps stub — mirroring the
 * `evaluateContracts` / `semanticSearchForTool` pattern of exporting the core
 * logic for tests.
 *
 * @throws {Error} When the task description is empty.
 */
export function recommendSkillsForTool(
  deps: McpDependencies,
  args: RecommendSkillsArgs,
): RecommendSkillsResult {
  const task = args.task.trim();
  if (task.length === 0) {
    throw new Error('recommend_skills: a non-empty task description is required.');
  }

  // Optional repo evidence — when the scale report is available, skills with
  // actual evidence files in this repo rank higher and the reason explains why.
  let evidence: Record<string, SkillEvidence> = {};
  try {
    if (deps.scale) {
      evidence = extractCodebaseSkills(deps.scale.getScaleReport().modules);
    }
  } catch {
    // Scale report unavailable (unscanned project) — catalog-only ranking.
    evidence = {};
  }

  const taskTokens = tokenize(task);
  const scored: Array<{
    skill: SkillDefinition;
    score: number;
    matchedTerms: string[];
    hasEvidence: boolean;
  }> = SKILL_CATALOG.map((skill) => {
    const hasEvidence = Object.prototype.hasOwnProperty.call(evidence, skill.id);
    const { score, matchedTerms } = scoreSkill(skill, taskTokens, hasEvidence);
    return { skill, score, matchedTerms, hasEvidence };
  });

  // Stable ranking: score desc, then importance desc, then catalog order.
  scored.sort((a, b) => b.score - a.score || b.skill.importance - a.skill.importance);

  // When at least one skill matches the task text, keep only token-matched
  // skills above the relevance floor. When NOTHING matches (uninformative
  // task text), fall back to importance-ranked catalog skills — an empty
  // recommendation list would be useless to the caller.
  const anyTokenMatch = scored.some((s) => s.matchedTerms.length > 0);
  const pool = anyTokenMatch
    ? scored.filter((s) => s.matchedTerms.length > 0 && s.score >= MIN_SCORE)
    : scored;

  const limit = Math.max(1, args.limit ?? 5);
  const recommendations: SkillRecommendation[] = pool.slice(0, limit).map((s) => {
    const reasons: string[] = [];
    if (s.matchedTerms.length > 0) {
      reasons.push(`task mentions ${s.matchedTerms.slice(0, 4).join(', ')}`);
    } else {
      reasons.push('broadly useful for this project (high importance)');
    }
    if (s.hasEvidence) {
      reasons.push('evidenced in this repo');
    }
    reasons.push(s.skill.whyItHelps);
    return {
      name: s.skill.label,
      description: s.skill.description,
      score: Math.round(s.score * 100) / 100,
      reason: reasons.join(' — '),
      id: s.skill.id,
      suggestedCommands: s.skill.suggestedCommands,
      resources: s.skill.resources,
    };
  });

  return {
    task,
    recommendations,
    totalSkillsConsidered: SKILL_CATALOG.length,
    note: "Deterministic lexical ranking (no LLM): score combines task-token overlap with each skill's registry text, task keyword hints, repo evidence and skill importance.",
  };
}

export function registerRecommendSkillsTool(server: McpServer, deps: McpDependencies): void {
  server.registerTool(
    'recommend_skills',
    {
      title: 'Recommend Skills',
      description:
        'Recommend the most relevant skills from the skills registry for a given task description.\n' +
        'WHEN to call: at the start of a task — "I need to add OAuth token refresh, which skills matter?" — or when deciding what to learn/review before editing.\n' +
        'Ranks the skill catalog by task-token overlap, repo evidence and importance; returns ranked skills with a relevance score, a reason, and the CLI commands to apply each.',
      inputSchema: {
        task: z
          .string()
          .min(1)
          .describe(
            'Free-text description of the task (e.g. "add rate limiting to the login endpoint")',
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe('Maximum number of recommendations to return (default 5)'),
      },
    },
    async (args) => {
      try {
        const result = recommendSkillsForTool(deps, {
          task: args.task,
          limit: args.limit,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
        };
      }
    },
  );
}
