import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { ActionableProjectMindError, actionableError } from '../../utils/actionable-error.js';
import { assertProjectPath } from '../security/path-security.js';

const ReviewRuleSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
    severity: z.enum(['high', 'medium', 'low']),
    confidenceThreshold: z.number().min(0).max(1).default(0.7),
    enabled: z.boolean().default(true),
    cwe: z
      .string()
      .regex(/^CWE-\d+$/)
      .optional(),
    owasp: z.string().max(80).optional(),
    message: z.string().min(1).max(500),
    contains: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe('Literal source text for a repository-specific rule'),
  })
  .strict();

export const ReviewPolicySchema = z
  .object({
    version: z.literal(1),
    mode: z.enum(['diff', 'full']).default('diff'),
    preset: z.enum(['precision-first', 'recall-first']).default('precision-first'),
    include: z.array(z.string().min(1).max(300)).max(200).default(['**/*']),
    exclude: z.array(z.string().min(1).max(300)).max(200).default([]),
    maxBundleBytes: z.number().int().min(1024).max(50_000_000).default(500_000),
    maxBundleTokens: z.number().int().min(256).max(10_000_000).default(100_000),
    concurrency: z.number().int().min(1).max(32).default(2),
    bundleTimeoutMs: z.number().int().min(1).max(300_000).default(30_000),
    bundleRetries: z.number().int().min(0).max(5).default(1),
    requiredChecks: z
      .array(z.enum(['typecheck', 'lint', 'test', 'security']))
      .max(10)
      .default(['typecheck', 'security']),
    output: z.enum(['json', 'markdown', 'sarif']).default('json'),
    rules: z.array(ReviewRuleSchema).max(200).default([]),
    suppressions: z
      .array(
        z
          .object({
            ruleId: z.string().min(1),
            reason: z.string().min(10).max(1000),
            expiresAt: z.string().datetime(),
          })
          .strict(),
      )
      .max(200)
      .default([]),
  })
  .strict();

export type ReviewPolicy = z.infer<typeof ReviewPolicySchema>;
export type ReviewRule = z.infer<typeof ReviewRuleSchema>;

export const DEFAULT_REVIEW_RULES: ReviewRule[] = [
  {
    id: 'dangerous-eval',
    severity: 'high',
    confidenceThreshold: 0.95,
    enabled: true,
    cwe: 'CWE-95',
    owasp: 'A03:2021 Injection',
    message: 'Dynamic code execution requires explicit security review.',
  },
  {
    id: 'possible-secret',
    severity: 'high',
    confidenceThreshold: 0.8,
    enabled: true,
    cwe: 'CWE-798',
    owasp: 'A07:2021 Identification and Authentication Failures',
    message: 'Possible hard-coded credential or secret.',
  },
  {
    id: 'explicit-any',
    severity: 'medium',
    confidenceThreshold: 0.9,
    enabled: true,
    cwe: 'CWE-704',
    message: 'Explicit any weakens the static contract at a changed line.',
  },
  {
    id: 'todo-marker',
    severity: 'low',
    confidenceThreshold: 0.7,
    enabled: true,
    message: 'Unresolved work marker in changed code.',
  },
  {
    id: 'console-output',
    severity: 'low',
    confidenceThreshold: 0.7,
    enabled: true,
    message: 'Ad-hoc console output should be reviewed for production behavior.',
  },
];

export const DEFAULT_REVIEW_POLICY: ReviewPolicy = ReviewPolicySchema.parse({
  version: 1,
  rules: DEFAULT_REVIEW_RULES,
});

function basicGlobMatch(pattern: string, value: string): boolean {
  const normalizedPattern = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  const normalizedValue = value.replace(/\\/g, '/').replace(/^\.\//, '');
  let source = '^';
  for (let index = 0; index < normalizedPattern.length; index++) {
    const character = normalizedPattern[index];
    if (character === '*' && normalizedPattern[index + 1] === '*') {
      index++;
      if (normalizedPattern[index + 1] === '/') {
        source += '(?:.*/)?';
        index++;
      } else source += '.*';
    } else if (character === '*') source += '[^/]*';
    else if (character === '?') source += '[^/]';
    else source += /[\\^$+?.()|{}[\]]/.test(character) ? `\\${character}` : character;
  }
  const expression = `${source}$`;
  return new RegExp(expression, 'i').test(normalizedValue);
}

export function policyIncludesFile(policy: ReviewPolicy, relativePath: string): boolean {
  const included = policy.include.some((pattern) => basicGlobMatch(pattern, relativePath));
  const excluded = policy.exclude.some((pattern) => basicGlobMatch(pattern, relativePath));
  return included && !excluded;
}

export function effectiveRules(policy: ReviewPolicy): ReviewRule[] {
  const rules = policy.rules.length > 0 ? policy.rules : DEFAULT_REVIEW_RULES;
  const now = Date.now();
  const suppressed = new Set(
    policy.suppressions
      .filter((item) => Date.parse(item.expiresAt) >= now)
      .map((item) => item.ruleId),
  );
  return rules.filter((rule) => rule.enabled && !suppressed.has(rule.id));
}

export function parseReviewPolicy(raw: unknown, source = 'review policy'): ReviewPolicy {
  const parsed = ReviewPolicySchema.safeParse(raw);
  if (parsed.success) {
    const unsupported = parsed.data.rules.find(
      (rule) => !rule.contains && !DEFAULT_RULE_PATTERN_IDS.has(rule.id),
    );
    if (unsupported) {
      throw actionableError(
        'review.unsupported-rule',
        `Review rule "${unsupported.id}" has no executable matcher.`,
        ['Use a built-in rule id or add a literal `contains` matcher to the policy rule.'],
        { cause: 'unsupported', details: `Rule: ${unsupported.id}`, retryable: false },
      );
    }
    return parsed.data;
  }
  const issue = parsed.error.issues[0];
  throw actionableError(
    'review.invalid-policy',
    `Invalid ${source}${issue?.path.length ? ` at ${issue.path.join('.')}` : ''}: ${issue?.message ?? 'unknown validation error'}`,
    ['Fix the reported field and run `pm review --policy .projectmind/review-policy.json` again.'],
    { cause: 'validation', details: JSON.stringify(parsed.error.issues), retryable: false },
  );
}

const DEFAULT_RULE_PATTERN_IDS: ReadonlySet<string> = new Set([
  'dangerous-eval',
  'possible-secret',
  'explicit-any',
  'todo-marker',
  'console-output',
]);

export function loadReviewPolicy(projectRoot: string, policyPath?: string): ReviewPolicy {
  const root = resolve(projectRoot);
  const candidate = policyPath
    ? assertProjectPath(policyPath, root, { mustExist: true })
    : join(root, '.projectmind', 'review-policy.json');
  if (!existsSync(candidate)) return DEFAULT_REVIEW_POLICY;
  try {
    return parseReviewPolicy(JSON.parse(readFileSync(candidate, 'utf8')), candidate);
  } catch (error) {
    if (error instanceof ActionableProjectMindError) throw error;
    throw actionableError(
      'review.policy-read-failed',
      `Unable to read review policy: ${candidate}`,
      ['Check that the policy is valid UTF-8 JSON and retry.'],
      {
        cause: 'filesystem',
        details: error instanceof Error ? error.message : String(error),
        retryable: true,
      },
    );
  }
}
