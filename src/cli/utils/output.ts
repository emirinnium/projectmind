import { logger } from '@/utils/logger.js';

export const output = {
  info: (message: string) => logger.info(message),
  warn: (message: string) => logger.warn(message),
  error: (message: string) => logger.error(message),
  success: (message: string) => logger.info(`✓ ${message}`),
  section: (title: string) => logger.info(`\n=== ${title} ===`),
  kv: (key: string, value: string | number) => logger.info(`  ${key}: ${value}`),
  list: (items: string[]) => items.forEach((item) => logger.info(`  - ${item}`)),
  table: (rows: Record<string, string | number | boolean | null>[]) => console.table(rows),
  /** Write a machine-readable document without contaminating stdout. */
  json: (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`),
  raw: (value: string) => process.stdout.write(`${value}\n`),
};
