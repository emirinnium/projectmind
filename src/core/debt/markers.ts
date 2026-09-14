import ts from 'typescript';

export interface DebtMarker {
  kind: 'TODO' | 'FIXME' | 'HACK';
  line: number;
  note: string;
}

const MARKER_PATTERN = /^\s*(?:\*+\s*)?(TODO|FIXME|HACK)\b(?::|\s|$)(.*)$/i;

function lineStartsOf(content: string): number[] {
  const starts = [0];
  for (let index = 0; index < content.length; index++) {
    if (content[index] === '\n') starts.push(index + 1);
  }
  return starts;
}

function lineNumberAt(starts: number[], position: number): number {
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (starts[middle]! <= position) low = middle + 1;
    else high = middle;
  }
  return low;
}

function stripCommentSyntax(line: string, token: ts.SyntaxKind, lineIndex: number): string {
  let cleaned = line;
  if (token === ts.SyntaxKind.SingleLineCommentTrivia) {
    return cleaned.replace(/^\s*\/\/\s?/, '');
  }
  if (lineIndex === 0) cleaned = cleaned.replace(/^\s*\/\*+\s?/, '');
  cleaned = cleaned.replace(/^\s*\*+\s?/, '');
  return cleaned.replace(/\s*\*\/\s*$/, '');
}

function collectCommentRanges(content: string): ts.CommentRange[] {
  const sourceFile = ts.createSourceFile(
    'projectmind-inline.tsx',
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const ranges = new Map<number, ts.CommentRange>();

  const collect = (candidateRanges: readonly ts.CommentRange[] | undefined): void => {
    for (const range of candidateRanges ?? []) ranges.set(range.pos, range);
  };

  const visit = (node: ts.Node): void => {
    collect(ts.getLeadingCommentRanges(content, node.getFullStart()));
    collect(ts.getTrailingCommentRanges(content, node.getEnd()));
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return [...ranges.values()].sort((left, right) => left.pos - right.pos);
}

/**
 * Find one actionable debt marker per comment source line.
 *
 * TypeScript's comment-range API lets this lightweight detector ignore marker
 * words inside strings, regular expressions and generated test fixtures. A
 * marker must begin a comment line (after the optional block-comment `*`
 * prefix), which prevents this detector's own documentation from reporting
 * itself as project debt. Parsing is error-tolerant: diagnostics do not throw
 * and comment ranges remain available for partially invalid source.
 */
export function findDebtMarkers(content: string): DebtMarker[] {
  const starts = lineStartsOf(content);
  const markers: DebtMarker[] = [];
  for (const range of collectCommentRanges(content)) {
    const commentLines = content.slice(range.pos, range.end).split(/\r\n|\n|\r/);
    let offset = 0;
    for (const [lineIndex, rawLine] of commentLines.entries()) {
      const cleaned = stripCommentSyntax(rawLine, range.kind, lineIndex);
      const match = cleaned.match(MARKER_PATTERN);
      if (match) {
        markers.push({
          kind: match[1]!.toUpperCase() as DebtMarker['kind'],
          line: lineNumberAt(starts, range.pos + offset),
          note: (match[2] ?? '').trim(),
        });
      }
      if (lineIndex < commentLines.length - 1) {
        const newlinePosition = range.pos + offset + rawLine.length;
        const newlineLength = content.startsWith('\r\n', newlinePosition) ? 2 : 1;
        offset += rawLine.length + newlineLength;
      } else {
        offset += rawLine.length;
      }
    }
  }
  return markers;
}

/** Count one actionable debt marker per source comment line. */
export function countDebtMarkers(content: string): number {
  return findDebtMarkers(content).length;
}
