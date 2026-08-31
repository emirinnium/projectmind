/**
 * Utility functions for scale reporting
 */

/** Round a value to 2 decimal places. */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Count the number of matches of a regex in content.
 * Returns 0 if content is null/undefined.
 */
export function countMatches(content: string, regex: RegExp): number {
  return (content.match(regex) ?? []).length;
}

/**
 * Classify the dominant error handling style based on code patterns.
 */
export function classifyErrorHandling(
  tryBlocks: number,
  dotCatch: number,
  throws: number,
  resultObjects: number
): string {
  const styles: Array<[string, number]> = [
    ['try-catch', tryBlocks],
    ['promise-catch', dotCatch],
    ['throwing', throws],
    ['result-object', resultObjects],
  ];
  const active = styles.filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  if (active.length === 0) return 'unknown';
  if (active.length === 1) return active[0][0];
  // Dominant only when at least twice as common as the runner-up.
  return active[0][1] >= active[1][1] * 2 ? active[0][0] : 'mixed';
}

/**
 * Determine the dominant naming convention from counts.
 */
export function dominantNaming(camel: number, snake: number, pascal: number): string {
  const total = camel + snake + pascal;
  if (total === 0) return 'unknown';
  const entries: Array<[string, number]> = [
    ['camelCase', camel],
    ['snake_case', snake],
    ['PascalCase', pascal],
  ];
  entries.sort((a, b) => b[1] - a[1]);
  return entries[0][1] >= total * 0.6 ? entries[0][0] : 'mixed';
}

/**
 * Derive a coding-style fingerprint from the real content of files an agent
 * touched. All metrics are computed from source text; when nothing is
 * readable the unmeasured sentinel (-1/'unknown') is returned instead of a
 * placeholder value.
 */
export function computeFingerprint(
  relativePaths: string[],
  projectRoot: string
): import('./types.js').AgentProfile['fingerprint'] {
  const root = projectRoot;
  let asyncHits = 0;
  let thenHits = 0;
  let assertionCount = 0;
  let totalLines = 0;
  let tryBlocks = 0;
  let dotCatch = 0;
  let throws = 0;
  let resultObjects = 0;
  let camel = 0;
  let snake = 0;
  let pascal = 0;

  let read = 0;
  const FINGERPRINT_MAX_FILES = 30;
  const FINGERPRINT_MAX_BYTES = 512 * 1024;

  // Import fs and path inline to avoid top-level circular deps
  const { readFileSync } = require('node:fs');
  const { join } = require('node:path');

  for (const rel of relativePaths) {
    if (read >= FINGERPRINT_MAX_FILES) break;
    let content: string;
    try {
      const buf = readFileSync(join(root, rel));
      if (buf.length > FINGERPRINT_MAX_BYTES) continue;
      content = buf.toString('utf-8');
    } catch {
      continue; // Deleted/moved/binary — skip silently.
    }
    read++;
    totalLines += content.split(/\r?\n/).length;

    asyncHits += countMatches(content, /\b(?:async|await)\b/g);
    thenHits += countMatches(content, /\.then\s*\(/g);
    assertionCount += countMatches(content, /\bas\s+[A-Za-z_$][\w$.<>\[\]]*/g);
    tryBlocks += countMatches(content, /\btry\s*\{/g);
    dotCatch += countMatches(content, /\.catch\s*\(/g);
    throws += countMatches(content, /\bthrow\b/g);
    resultObjects += countMatches(content, /\{\s*(?:ok|err)\s*[:,]/g);

    for (const m of content.matchAll(/(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) {
      const name = m[1];
      if (/^[a-z][\w$]*$/.test(name)) camel++;
      else if (/^[a-z]+(?:_[a-z0-9]+)+$/.test(name)) snake++;
      else if (/^[A-Z][\w$]*$/.test(name)) pascal++;
    }
  }

  if (read === 0 || totalLines === 0) {
    return {
      asyncPreference: -1,
      typeStrictness: -1,
      errorHandlingStyle: 'unknown',
      namingConvention: 'unknown',
      testPattern: 'none',
      favoriteAbstractions: ['none'],
    };
  }

  // Promise-style (async/await) vs then-chain preference.
  const styleDenominator = asyncHits + thenHits;

  return {
    asyncPreference:
      styleDenominator > 0 ? round2(asyncHits / styleDenominator) : -1,
    // `as` assertions per 10 lines of code, capped at 1.0.
    typeStrictness: Math.min(1, round2(assertionCount / (totalLines / 10))),
    errorHandlingStyle: classifyErrorHandling(tryBlocks, dotCatch, throws, resultObjects),
    namingConvention: dominantNaming(camel, snake, pascal),
    testPattern: 'none',
    favoriteAbstractions: ['none'],
  };
}