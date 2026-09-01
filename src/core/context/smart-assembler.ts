/**
 * Smart Context Assembler v1 — wrapper re-export.
 *
 * Re-exports the user-facing and system-facing context assemblers so that
 * importing code can rely on a single stable path while the implementation
 * is split into specialized modules.
 */

export {
  assembleUserContext,
  UserContextItem,
  UserContextResult,
} from './user-context-assembler.js';
export {
  assembleSystemContext,
  SystemContextItem,
  SystemContextResult,
} from './system-context-assembler.js';
