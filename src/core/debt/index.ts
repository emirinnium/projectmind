export { DebtTracker } from './tracker.js';
export type { DebtItem, DebtReport, DebtType, Severity } from './tracker.js';

/** Cognitive load score at/above which a file is flagged for refactoring (high severity). */
export const COGNITIVE_LOAD_THRESHOLD = 0.7;
