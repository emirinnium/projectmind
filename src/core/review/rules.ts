import type { ReviewRule } from './policy.js';
import ts from 'typescript';

export const REVIEW_RULE_PATTERNS: Readonly<Record<string, RegExp>> = {
  'dangerous-eval': /\b(?:eval|new\s+Function)\s*\(/,
  'possible-secret': /(?:api[_-]?key|secret|password|token)\s*[:=]\s*['"][^'"]{8,}/i,
  'explicit-any': /\bany\b/,
  'todo-marker': /\b(?:TODO|FIXME|HACK)\b/i,
  'console-output': /\bconsole\.(?:log|error|warn|debug)\s*\(/,
};

export function ruleMatchesSourceLine(rule: string | ReviewRule, line: string): boolean {
  if (typeof rule !== 'string' && rule.contains) return line.includes(rule.contains);
  const id = typeof rule === 'string' ? rule : rule.id;
  if (id === 'explicit-any') {
    // Regex matching sees comments and string literals as source. Parse the
    // line instead so this rule only reports an actual TypeScript AnyKeyword.
    const source = ts.createSourceFile(
      'review-line.ts',
      line,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    let found = false;
    const visit = (node: ts.Node): void => {
      if (node.kind === ts.SyntaxKind.AnyKeyword) found = true;
      if (!found) ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
  }
  return REVIEW_RULE_PATTERNS[id]?.test(line) ?? false;
}

export function reviewRuleForLine(rule: ReviewRule, line: string): boolean {
  return rule.enabled && ruleMatchesSourceLine(rule, line);
}
