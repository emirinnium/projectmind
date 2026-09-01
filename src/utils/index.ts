// Unified Utils Barrel
// Re-exports all utility modules for convenient importing

// Project Config
export { loadConfig, getConfigPath, type ProjectMindConfig } from './config.js';

// Error handling utilities
export {
  tryCatch,
  tryCatchAsync,
  safeExecute,
  safeExecuteAsync,
  assert,
  require,
  type Result,
} from './errors.js';

// CLI Logger
export { logger, type LogLevel } from '../cli/utils/logger.js';

// CLI Shared Utilities (context, services, output, helpers)
export {
  // Context management
  createContext,
  closeContext,
  withContext,
  type CLIContext,
  type ContextFn,

  // Service wrappers
  withService,
  withScale,
  withDebt,
  withCoherence,
  withServices,
  type ServiceMap,

  // Output formatting
  output,
  formatGenomeScore,
  formatDebtReport,

  // Error handling
  handleCliError,
  asyncHandler,

  // File operations
  getFilesToCheck,

  // Base command class
  BaseCommand,

  // Retry utilities
  withRetry,
  type RetryOptions,

  // Debug utilities
  debug,

  // Agent tracking
  trackAgentTouched,
} from '../cli/utils/shared.js';
