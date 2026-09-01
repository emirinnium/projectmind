/**
 * Shared CLI utilities - barrel re-export file
 * Split across multiple modules for maintainability.
 */

// Re-export commonly used utilities from their ACTUAL source modules.
// Never re-export from the root barrel here: shared.ts is re-exported BY
// @/index.js (via utils/index.js), so importing the barrel back creates a
// circular re-export chain (index.ts -> utils/index.ts -> shared.ts -> index.ts).
export { loadConfig } from '@/utils/config.js';
export { logger } from '@/utils/logger.js';
export { join, dirname } from 'node:path';
export { existsSync, mkdirSync, statSync } from 'node:fs';

// Re-export all split modules
export { CLIContext, ContextFn, createContext, closeContext } from './context.js';
export {
  withContext,
  withService,
  withScale,
  withDebt,
  withCoherence,
  withServices,
  ServiceMap,
} from './services.js';
export { output } from './output.js';
export { formatGenomeScore, formatDebtReport, handleCliError, asyncHandler } from './formatters.js';
export { getFilesToCheck } from './files.js';
export { withRetry, RetryOptions } from './retry.js';
export { debug } from './debug.js';
export { trackAgentTouched } from './agent.js';
export { BaseCommand } from './base-command.js';
