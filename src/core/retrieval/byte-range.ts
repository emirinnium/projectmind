import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { assertProjectPath } from '../security/path-security.js';

export interface SourceRangeResult {
  success: true;
  filePath: string;
  startByte: number;
  endByte: number;
  lineStart: number;
  lineEnd: number;
  columnStart: number;
  columnEnd: number;
  content: string;
  sourceHash: string;
  encoding: 'utf-8';
  lineEnding: 'lf' | 'crlf' | 'mixed' | 'none';
  sourceBytes: number;
  returnedBytes: number;
  estimatedSourceTokens: number;
  estimatedReturnedTokens: number;
  bytesSaved: number;
  estimatedTokensSaved: number;
  truncated: boolean;
  nextRange?: { startByte: number; endByte: number };
}

function lineEnding(content: string): SourceRangeResult['lineEnding'] {
  const crlf = (content.match(/\r\n/g) ?? []).length;
  const lf = (content.match(/(?<!\r)\n/g) ?? []).length;
  if (crlf === 0 && lf === 0) return 'none';
  if (crlf > 0 && lf > 0) return 'mixed';
  return crlf > 0 ? 'crlf' : 'lf';
}

function positionAtByte(content: Buffer, byteOffset: number): { line: number; column: number } {
  const prefix = content.subarray(0, byteOffset).toString('utf8');
  const lines = prefix.split(/\r?\n/);
  return { line: lines.length, column: (lines.at(-1) ?? '').length + 1 };
}

/** Read an exact UTF-8 byte range without exposing the rest of the file. */
export function readSourceRange(
  filePath: string,
  projectRoot: string,
  startByte: number,
  endByte: number,
  maxBytes = 64 * 1024,
): SourceRangeResult {
  const absolutePath = assertProjectPath(filePath, projectRoot, {
    mustExist: true,
    rejectIgnored: true,
    maxBytes: 50 * 1024 * 1024,
  });
  const bytes = readFileSync(absolutePath);
  if (
    !Number.isSafeInteger(startByte) ||
    !Number.isSafeInteger(endByte) ||
    startByte < 0 ||
    endByte < startByte
  ) {
    throw new Error(
      'Invalid byte range: startByte/endByte must be non-negative integers with endByte >= startByte.',
    );
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1_000_000) {
    throw new Error('Invalid maxBytes: use an integer between 1 and 1000000.');
  }
  if (startByte > bytes.length)
    throw new Error(`Byte range starts beyond the file (${bytes.length} bytes).`);
  const requestedEnd = Math.min(endByte, bytes.length);
  if (!isUtf8Boundary(bytes, startByte) || !isUtf8Boundary(bytes, requestedEnd)) {
    throw new Error(
      'Byte range splits a UTF-8 code point. Retry with boundaries at the start or end of a character.',
    );
  }
  const actualEnd = Math.min(requestedEnd, startByte + maxBytes);
  const content = bytes.subarray(startByte, actualEnd).toString('utf8');
  const start = positionAtByte(bytes, startByte);
  const end = positionAtByte(bytes, actualEnd);
  const truncated = actualEnd < requestedEnd;
  return {
    success: true,
    filePath: filePath.replace(/\\/g, '/'),
    startByte,
    endByte: actualEnd,
    lineStart: start.line,
    lineEnd: end.line,
    columnStart: start.column,
    columnEnd: end.column,
    content,
    sourceHash: createHash('sha256').update(bytes).digest('hex'),
    encoding: 'utf-8',
    lineEnding: lineEnding(bytes.toString('utf8')),
    sourceBytes: bytes.length,
    returnedBytes: actualEnd - startByte,
    estimatedSourceTokens: Math.max(1, Math.ceil(bytes.length / 4)),
    estimatedReturnedTokens: Math.max(1, Math.ceil((actualEnd - startByte) / 4)),
    bytesSaved: Math.max(0, bytes.length - (actualEnd - startByte)),
    estimatedTokensSaved: Math.max(
      0,
      Math.ceil(bytes.length / 4) - Math.ceil((actualEnd - startByte) / 4),
    ),
    truncated,
    nextRange: truncated ? { startByte: actualEnd, endByte: requestedEnd } : undefined,
  };
}

function isUtf8Boundary(bytes: Buffer, offset: number): boolean {
  if (offset <= 0 || offset >= bytes.length) return true;
  return (bytes[offset] & 0xc0) !== 0x80;
}
