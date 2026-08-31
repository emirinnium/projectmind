import { logger } from '@/utils/logger.js';

export const output = {
  info: (message: string) => logger.info(message),
  warn: (message: string) => logger.warn(message),
  error: (message: string) => logger.error(message),
  success: (message: string) => logger.info(`✓ ${message}`),
  section: (title: string) => logger.info(`\n=== ${title} ===`),
  kv: (key: string, value: string | number) => logger.info(`  ${key}: ${value}`),
  list: (items: string[]) => items.forEach(item => logger.info(`  - ${item}`)),
  table: (rows: Record<string, string | number | boolean | null>[]) => console.table(rows),
};
