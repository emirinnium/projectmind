import { z } from 'zod';
import { createHash } from 'node:crypto';
import { fingerprintExtractor } from './fingerprint.js';
import {
  ERROR_HANDLING_STYLES,
  NAMING_CONVENTIONS,
  TEST_PATTERNS,
} from '../../storage/kg/types.js';
import type { AgentFingerprint, FingerprintMeasured } from '../../storage/kg/types.js';
import type {
  SkillDefinition,
  SkillEvidence,
  SkillGap,
  ProficiencyEvidence,
} from './skill-catalog.js';
import { SKILL_CATALOG } from './skill-catalog.js';

export type {
  SkillDefinition,
  SkillEvidence,
  SkillGap,
  ProficiencyEvidence,
} from './skill-catalog.js';
export { SKILL_CATALOG } from './skill-catalog.js';
import { Result } from '../../utils/errors.js';
import type { DatabaseSync } from 'node:sqlite';
import { getDatabase } from '../../storage/database.js';
import { logger } from '../../utils/logger.js';

const MAX_EVIDENCE_FILES = 8;

/** Build the evidence map for this repo from the scale report module list. */
export function extractCodebaseSkills(
  modules: Array<{ files?: Array<{ relativePath?: string; language?: string }> }>,
): Record<string, SkillEvidence> {
  const evidence: Record<string, SkillEvidence> = {};
  for (const def of SKILL_CATALOG) {
    evidence[def.id] = {
      id: def.id,
      description: def.description,
      whyItHelps: def.whyItHelps,
      importance: def.importance,
      files: [],
      suggestedCommands: def.suggestedCommands,
    };
  }

  const filePaths = collectModuleFilePaths(modules);
  if (filePaths.length === 0) return evidence; // no scan data: catalog only

  for (const { rel, lang } of filePaths) {
    if (
      lang === 'typescript' &&
      evidence['typescript'].files.length < MAX_EVIDENCE_FILES &&
      !evidence['typescript'].files.includes(rel)
    ) {
      evidence['typescript'].files.push(rel);
    }
    for (const def of SKILL_CATALOG) {
      const target = evidence[def.id];
      if (target.files.length >= MAX_EVIDENCE_FILES) continue;
      if (target.files.includes(rel)) continue; // never double-list the same file in one skill
      if (def.indicators.some((re) => re.test(rel))) target.files.push(rel);
    }
  }

  // Drop skills with zero repo evidence — the catalog should reflect reality.
  for (const [id, info] of Object.entries(evidence)) {
    if (info.files.length === 0) delete evidence[id];
  }

  return evidence;
}

function collectModuleFilePaths(
  modules: Array<{ files?: Array<{ relativePath?: string; language?: string }> }>,
): Array<{ rel: string; lang: string }> {
  const seen = new Set<string>();
  const out: Array<{ rel: string; lang: string }> = [];
  for (const m of modules ?? []) {
    for (const f of m?.files ?? []) {
      if (typeof f?.relativePath === 'string' && f.relativePath.length > 0) {
        const rel = f.relativePath.replace(/\\/g, '/');
        if (seen.has(rel)) continue;
        seen.add(rel);
        out.push({ rel, lang: String(f.language ?? '') });
      }
    }
  }
  return out;
}

/**
 * Estimate an agent's proficiency in ONE skill from real interaction evidence:
 *   - touched files matching the skill's path signals (strongest signal)
 *   - session count → base activity
 *   - session decisions text matching the skill signals
 *   - async fingerprint hint (only for async-patterns)
 * Evidence is additive, capped at 1.0. Zero evidence stays 0 — nothing is
 * ever fabricated or guessed.
 */
export function estimateSkillProficiency(skill: SkillDefinition, ev: ProficiencyEvidence): number {
  let score = 0;

  for (const path of ev.touchedPaths) {
    if (skill.indicators.some((re) => re.test(path))) {
      score += 0.35;
      if (score >= 1) return 1;
    }
  }

  score += Math.min(1, ev.sessionCount / 10) * 0.15;

  if (ev.decisionsText.length > 0) {
    const decisionHits = skill.indicators.filter((re) => re.test(ev.decisionsText)).length;
    score += Math.min(decisionHits, 3) * 0.1;
  }

  if (skill.id === 'async-patterns' && ev.asyncPreference >= 0.5) {
    score += 0.15;
  }

  return Math.min(1, score);
}

/** Per-skill proficiency map for an agent. */
export function estimateAllProficiencies(ev: ProficiencyEvidence): Record<string, number> {
  const proficiencies: Record<string, number> = {};
  for (const def of SKILL_CATALOG) {
    proficiencies[def.id] = estimateSkillProficiency(def, ev);
  }
  return proficiencies;
}

/** Gap analysis over the repo evidence map. Threshold = minimum gap to report (0-1). */
export function analyzeSkillGaps(
  proficiencies: Record<string, number>,
  evidence: Record<string, SkillEvidence>,
  threshold: number,
): SkillGap[] {
  const gaps: SkillGap[] = [];

  for (const [id, info] of Object.entries(evidence)) {
    const def = SKILL_CATALOG.find((d) => d.id === id);
    const currentLevel = proficiencies[id] ?? 0;
    const targetLevel = info.importance;
    const gap = targetLevel - currentLevel;

    if (gap >= threshold) {
      let priority: SkillGap['priority'] = 'low';
      if (gap > 0.5 && info.importance > 0.8) priority = 'critical';
      else if (gap > 0.4) priority = 'high';
      else if (gap > 0.25) priority = 'medium';

      gaps.push({
        skill: id,
        label: def?.label ?? id,
        description: info.description,
        whyItHelps: info.whyItHelps,
        currentLevel,
        targetLevel,
        gap,
        priority,
        learningResources: def?.resources ?? ['Official Documentation'],
        estimatedHours: Math.ceil(gap * 20),
        relatedFiles: info.files.slice(0, 5),
        suggestedCommands: info.suggestedCommands,
      });
    }
  }

  return gaps.sort((a, b) => b.gap - a.gap);
}

/**
 * Fingerprint shape accepted by the SKILL.md generator. Both fingerprint
 * lineages are valid inputs: the strict AgentFingerprint (skills extractor,
 * 0.5 neutral defaults, enum labels) and the scale reporter's lineage
 * fingerprint (-1 unmeasured sentinels, richer error-style labels). The
 * generator is presentation-only and renders negative numerics as
 * "unmeasured", so it accepts the common structural supertype.
 */
export interface SkillDocFingerprint {
  asyncPreference: number;
  typeStrictness: number;
  errorHandlingStyle: string;
  namingConvention: string;
  testPattern: string;
  favoriteAbstractions: string[];
}

export interface SkillDocParams {
  agentName: string;
  sessionCount: number;
  filesTouchedCount: number;
  fingerprint: SkillDocFingerprint;
  touchedPaths: string[];
  gaps: SkillGap[];
  generatedAt: string;
}

/**
 * Generate a personalized SKILL.md for one agent: frontmatter, measured
 * activity + coding fingerprint, per-skill "what it helps with" sections
 * ranked by gap, and the exact commands to close each gap.
 */
export function generateSkillDoc(params: SkillDocParams): string {
  const {
    agentName,
    sessionCount,
    filesTouchedCount,
    fingerprint,
    touchedPaths,
    gaps,
    generatedAt,
  } = params;
  const topGaps = gaps.slice(0, 8);

  const lines: string[] = [];
  lines.push('---');
  lines.push(`name: ${agentName}`);
  lines.push(`generatedAt: ${generatedAt}`);
  lines.push('generatedBy: projectmind skill-recommend --write');
  lines.push('---');
  lines.push('');
  lines.push('# ' + agentName + ' — Personalized Agent Skill');
  lines.push('');
  lines.push(
    `Measured from ${sessionCount} recorded session(s) and ${filesTouchedCount} agent-touched file(s).`,
  );
  lines.push('');
  lines.push('## Coding fingerprint (measured)');
  lines.push('');
  lines.push(
    '- Async preference: ' +
      (fingerprint.asyncPreference < 0
        ? 'unmeasured'
        : Math.round(fingerprint.asyncPreference * 100) + '%'),
  );
  lines.push(
    '- Type strictness: ' +
      (fingerprint.typeStrictness < 0
        ? 'unmeasured'
        : Math.round(fingerprint.typeStrictness * 100) + '%'),
  );
  lines.push(`- Error handling: ${fingerprint.errorHandlingStyle}`);
  lines.push(`- Naming convention: ${fingerprint.namingConvention}`);
  lines.push(`- Test pattern: ${fingerprint.testPattern}`);
  lines.push(`- Favorite abstractions: ${fingerprint.favoriteAbstractions.join(', ')}`);
  lines.push('');

  if (topGaps.length === 0) {
    lines.push('No significant skill gaps detected — this agent is well-matched to the codebase.');
    lines.push('');
    return lines.join('\n');
  }

  lines.push('## Recommended skill development (by gap)');
  lines.push('');
  for (const gap of topGaps) {
    lines.push(
      `### ${gap.label} — gap ${(gap.gap * 100).toFixed(0)}% (current ${(gap.currentLevel * 100).toFixed(0)}% → target ${(gap.targetLevel * 100).toFixed(0)}%)`,
    );
    lines.push('');
    lines.push(`**What it helps with:** ${gap.whyItHelps}`);
    lines.push('');
    lines.push(`**Description:** ${gap.description}`);
    lines.push('');
    if (gap.relatedFiles.length > 0) {
      lines.push(`**Evidence files:** ${gap.relatedFiles.join(', ')}`);
      lines.push('');
    }
    const cmdLine = '**Suggested commands:** `' + gap.suggestedCommands.join('` `') + '`';
    lines.push(cmdLine);
    lines.push('');
    lines.push(`**Learning resources:** ${gap.learningResources.join(', ')}`);
    lines.push('');
  }

  lines.push('## Suggested workflow');
  lines.push('');
  lines.push('1. Run the suggested command for the highest-gap skill to build practical context.');
  lines.push('2. Review the evidence files to see existing patterns before writing new code.');
  lines.push(
    '3. Re-run `pm skill-recommend --agent <name> --write` after focusing weeks to track progress.',
  );
  lines.push('');

  if (touchedPaths.length > 0) {
    lines.push('## Most recent touched files');
    lines.push('');
    lines.push('```text');
    for (const p of touchedPaths.slice(0, 12)) lines.push(p);
    lines.push('```');
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * GDPR / Privacy Note (Question 7):
 * AgentFingerprint contains coding-style metrics (asyncPreference, namingConvention,
 * errorHandlingStyle, etc.). These describe code patterns, not natural persons, and
 * are NOT personally identifiable information (PII) under GDPR Article 4(1).
 * However, if agentName is linked to a real person's identity, the profile should be
 * anonymized or consent-based. Recommend pseudonymous agent IDs (agent-001) rather
 * than real names for GDPR compliance.
 */
/** Profile storage integration: persist / load adaptive fingerprint per agent. */
/** Pseudonymize agent identifier for GDPR compliance — never persist raw id. */
export function pseudonymizeAgentId(agentId: string): string {
  return createHash('sha256')
    .update(agentId + 'projectmind-fingerprint-v1')
    .digest('hex')
    .slice(0, 16);
}

export function persistAgentProfile(
  agentName: string,
  fingerprint: AgentFingerprint,
  db?: DatabaseSync,
): boolean {
  try {
    const serialized = JSON.stringify(fingerprint);
    const database = db ?? getDatabase();
    const stmt = database.prepare(
      "INSERT OR REPLACE INTO agent_profiles (agent_name, fingerprint, updated_at) VALUES (?, ?, datetime('now'))",
    );
    // Retention: pseudonymized agent profiles retained for adaptive coherence only
    stmt.run(pseudonymizeAgentId(agentName), serialized);
    return true;
  } catch (e) {
    logger.warn('persistAgentProfile failed', {
      error: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

// Load-time schema for persisted profiles. The style fields are typed as
// strict literal unions in AgentFingerprint, but legacy rows were persisted
// under a z.string() schema and may hold free-form values — so validation
// stays lenient here (enum OR any string) rather than rejecting the whole
// profile. New writes always emit classifier enum values.
const AgentFingerprintSchema = z.object({
  asyncPreference: z.number(),
  typeStrictness: z.number(),
  errorHandlingStyle: z.union([z.enum(ERROR_HANDLING_STYLES), z.string()]),
  namingConvention: z.union([z.enum(NAMING_CONVENTIONS), z.string()]),
  testPattern: z.union([z.enum(TEST_PATTERNS), z.string()]),
  favoriteAbstractions: z.array(z.string()),
  measured: z
    .object({
      asyncPreference: z.boolean(),
      namingConvention: z.boolean(),
      errorHandlingStyle: z.boolean(),
    })
    .optional(),
});

export function loadAgentProfile(agentName: string, db?: DatabaseSync): Result<AgentFingerprint> {
  try {
    const database = db ?? getDatabase();
    const stmt = database.prepare('SELECT fingerprint FROM agent_profiles WHERE agent_name = ?');
    const row = stmt.get(pseudonymizeAgentId(agentName)) as { fingerprint: string } | undefined;
    if (!row) return { success: false, error: new Error('Agent profile not found') };
    try {
      const parsed = JSON.parse(row.fingerprint);
      const result = AgentFingerprintSchema.safeParse(parsed);
      if (!result.success) {
        logger.warn('loadAgentProfile zod validation failed', { error: result.error.message });
        return { success: false, error: new Error('Agent profile validation failed') };
      }
      return { success: true, value: result.data as AgentFingerprint };
    } catch {
      logger.warn('loadAgentProfile parse failed');
      return { success: false, error: new Error('Agent profile parse failed') };
    }
  } catch {
    return { success: false, error: new Error('Agent profile load failed') };
  }
}

export function adaptiveCoherenceCheck(
  filePath: string,
  content: string,
  agentName?: string,
): { verdict: 'pass' | 'warn' | 'fail'; message: string; styleMismatch?: boolean } {
  const result = agentName
    ? loadAgentProfile(agentName)
    : { success: true, value: null as unknown as AgentFingerprint };
  if (!result.success) {
    return {
      verdict: 'pass',
      message: 'No agent profile loaded; coherence unmeasured.',
      styleMismatch: false,
    };
  }
  const profile = result.value;
  // Compute fingerprint from current file content for comparison using the
  // fingerprint extractor that returns AgentFingerprint with measured flags
  const contentFp = fingerprintExtractor.extractFromAST(content);
  // Backward compatibility: profiles persisted before measurement metadata
  // existed carry no `measured` flags. Their dimensions hold neutral defaults
  // (asyncPreference 0.5, namingConvention 'unknown', errorHandlingStyle
  // 'try-catch') that cannot be distinguished from real signal, so skip the
  // comparison entirely instead of emitting false style warnings.
  const measured = profile.measured;
  if (!measured) {
    return {
      verdict: 'pass',
      message: `Coherence pass for ${filePath}; stored profile pre-dates measurement metadata, style comparison skipped.`,
      styleMismatch: false,
    };
  }
  // Per-dimension guard: a dimension with zero samples on EITHER side only
  // holds a neutral default — comparing it would produce false warnings.
  const bothMeasured = (dim: keyof FingerprintMeasured): boolean =>
    measured[dim] === true && contentFp.measured?.[dim] === true;
  const mismatches: string[] = [];
  if (
    bothMeasured('asyncPreference') &&
    Math.abs(contentFp.asyncPreference - profile.asyncPreference) > 0.3
  ) {
    mismatches.push(
      `asyncPreference differs (${contentFp.asyncPreference.toFixed(2)} vs ${profile.asyncPreference.toFixed(2)})`,
    );
  }
  if (bothMeasured('namingConvention') && contentFp.namingConvention !== profile.namingConvention) {
    mismatches.push(
      `namingConvention differs (${contentFp.namingConvention} vs ${profile.namingConvention})`,
    );
  }
  if (
    bothMeasured('errorHandlingStyle') &&
    contentFp.errorHandlingStyle !== profile.errorHandlingStyle
  ) {
    mismatches.push(
      `errorHandlingStyle differs (${contentFp.errorHandlingStyle} vs ${profile.errorHandlingStyle})`,
    );
  }
  if (mismatches.length > 0) {
    return {
      verdict: 'warn',
      message: `Style mismatch in ${filePath}: ${mismatches.join('; ')}`,
      styleMismatch: true,
    };
  }
  return {
    verdict: 'pass',
    message: `Coherence pass for ${filePath}; style aligned with ${agentName ?? 'agent'}.`,
    styleMismatch: false,
  };
}

export function extractFingerprintFromContent(content: string): AgentFingerprint {
  return fingerprintExtractor.extractFromAST(content);
}
