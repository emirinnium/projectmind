import type { TaskType } from './types.js';

export const TASK_KEYWORDS: Record<TaskType, string[]> = {
  'bug fix': ['fix', 'bug', 'error', 'crash', 'defect', 'issue', 'broken', 'fail'],
  feature: ['add', 'new', 'feature', 'implement', 'support', 'create', 'build', 'introduce'],
  refactor: ['refactor', 'cleanup', 'restructure', 'extract', 'simplify', 'reorganize', 'optimize'],
  test: ['test', 'coverage', 'spec', 'assert', 'verify', 'check', 'validate', 'lint'],
};

export function classifyTask(queryText: string): TaskType {
  const text = queryText.toLowerCase();
  const scores: Record<TaskType, number> = {
    'bug fix': 0,
    feature: 0,
    refactor: 0,
    test: 0,
  };
  for (const [task, keywords] of Object.entries(TASK_KEYWORDS)) {
    for (const keyword of keywords) {
      if (text.includes(keyword)) scores[task as TaskType] += 1;
    }
  }

  let best: TaskType = 'feature';
  let bestScore = -1;
  for (const [task, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestScore = score;
      best = task as TaskType;
    }
  }
  return bestScore <= 0 ? 'feature' : best;
}
