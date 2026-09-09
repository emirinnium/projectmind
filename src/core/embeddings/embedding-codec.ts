import type { SQLOutputValue } from 'node:sqlite';

/** Encode an embedding using the compact Float32 representation. */
export function encodeEmbedding(values: number[]): Buffer {
  if (!values.every(Number.isFinite)) {
    throw new RangeError('Embedding values must be finite numbers');
  }
  return Buffer.from(new Float32Array(values).buffer);
}

/**
 * Decode the two formats used by embedding columns.
 *
 * Float32 BLOBs are the current compact representation; JSON TEXT is kept
 * for databases created before the BLOB migration. Invalid, non-finite, or
 * truncated values are rejected as a whole so callers never rank partial or
 * misleading vectors.
 */
export function decodeEmbedding(raw: SQLOutputValue | null | undefined): number[] {
  if (raw instanceof Uint8Array) {
    if (raw.byteLength === 0 || raw.byteLength % 4 !== 0) return [];
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const values: number[] = [];
    for (let offset = 0; offset < raw.byteLength; offset += 4) {
      const value = view.getFloat32(offset, true);
      if (!Number.isFinite(value)) return [];
      values.push(value);
    }
    return values;
  }

  if (typeof raw !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const values = parsed.map((value) => {
      if (typeof value !== 'number' && typeof value !== 'string') return Number.NaN;
      return Number(value);
    });
    return values.length > 0 && values.every(Number.isFinite) ? values : [];
  } catch {
    return [];
  }
}
