import { statSync } from 'node:fs';

const DEFAULT_MAX_SOURCE_BYTES = 10 * 1024 * 1024;

export function getMaxSourceBytes(): number {
  const configured = Number.parseInt(process.env.PROJECTMIND_MAX_SOURCE_BYTES ?? '', 10);
  return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_MAX_SOURCE_BYTES;
}

export function assertSourceSize(filePath: string): void {
  const size = statSync(filePath).size;
  if (size > getMaxSourceBytes()) {
    throw new Error(
      `Source file exceeds PROJECTMIND_MAX_SOURCE_BYTES (${getMaxSourceBytes()}): ${filePath}`,
    );
  }
}

export function assertSourceTextSize(filePath: string, sourceText: string): void {
  const size = Buffer.byteLength(sourceText, 'utf8');
  if (size > getMaxSourceBytes()) {
    throw new Error(
      `Source content exceeds PROJECTMIND_MAX_SOURCE_BYTES (${getMaxSourceBytes()}): ${filePath}`,
    );
  }
}
