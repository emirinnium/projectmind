import { basename } from 'node:path';

export interface StaticSecurityRule {
  id: string;
  category: 'secrets' | 'crypto';
  severity: 'critical' | 'high' | 'medium';
  message: string;
  pattern: RegExp;
}

export interface StaticSecurityFinding {
  file: string;
  line: number;
  type: string;
  severity: StaticSecurityRule['severity'];
  message: string;
}

/**
 * Deterministic signatures shared by the CLI audit and maintainer security
 * measurement scripts.
 * They identify candidates; they do not prove a vulnerability.
 */
export const STATIC_SECURITY_RULES: readonly StaticSecurityRule[] = [
  {
    id: 'secret',
    category: 'secrets',
    severity: 'high',
    message: 'Potential secret detected',
    pattern: /(api[_-]?key|secret|token|password)\s*[:=]\s*["'][^"']+["']/gi,
  },
  {
    id: 'aws-key',
    category: 'secrets',
    severity: 'critical',
    message: 'Potential aws-key detected',
    pattern: /(aws[_-]?access[_-]?key|aws[_-]?secret[_-]?key)\s*[:=]\s*["'][^"']+["']/gi,
  },
  {
    id: 'private-key',
    category: 'secrets',
    severity: 'critical',
    message: 'Potential private-key detected',
    pattern: /-----BEGIN (RSA|EC|DSA) PRIVATE KEY-----/g,
  },
  {
    id: 'eval',
    category: 'secrets',
    severity: 'high',
    message: 'Potential eval detected',
    pattern: /eval\s*\(/g,
  },
  {
    id: 'function-constructor',
    category: 'secrets',
    severity: 'high',
    message: 'Potential function-constructor detected',
    pattern: /new Function\s*\(/g,
  },
  {
    id: 'weak-crypto',
    category: 'crypto',
    severity: 'medium',
    message: 'Potential weak-crypto detected',
    pattern: /crypto\.createCipher\(|crypto\.createDecipher\(/g,
  },
  {
    id: 'weak-hash',
    category: 'crypto',
    severity: 'medium',
    message: 'Potential weak-hash detected',
    pattern: /md5|sha1/gi,
  },
];

function lineNumberAtOffset(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index++) {
    if (source.charCodeAt(index) === 10) line++;
  }
  return line;
}

/** Scan one source string without executing it or making a vulnerability claim. */
export function scanStaticSecurityPatterns(
  source: string,
  filePath: string,
  categories: ReadonlySet<StaticSecurityRule['category']> = new Set(['secrets', 'crypto']),
): StaticSecurityFinding[] {
  const findings: StaticSecurityFinding[] = [];
  for (const rule of STATIC_SECURITY_RULES) {
    if (!categories.has(rule.category)) continue;
    rule.pattern.lastIndex = 0;
    const matchedLines = new Set<number>();
    for (const match of source.matchAll(rule.pattern)) {
      const offset = match.index ?? 0;
      const line = lineNumberAtOffset(source, offset);
      if (matchedLines.has(line)) continue;
      matchedLines.add(line);
      findings.push({
        file: filePath,
        line,
        type: rule.id,
        severity: rule.severity,
        message: rule.message,
      });
    }
    rule.pattern.lastIndex = 0;
  }
  return findings.sort(
    (left, right) =>
      left.line - right.line ||
      left.type.localeCompare(right.type) ||
      left.file.localeCompare(right.file),
  );
}

/** Avoid scanning detector signatures as application findings. */
export function isStaticAuditImplementation(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return (
    normalized === 'src/cli/commands/audit.ts' ||
    normalized === 'src/core/security/static-audit.ts' ||
    normalized.endsWith('/src/cli/commands/audit.ts') ||
    normalized.endsWith('/src/core/security/static-audit.ts') ||
    basename(normalized) === 'static-audit.ts'
  );
}
