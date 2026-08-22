import { logger } from '@/index.js';

export const debug = {
  enabled: process.env.DEBUG === '1' || process.env.PROJECTMIND_DEBUG === '1',
  
  log: (label: string, data: any) => {
    if (debug.enabled) {
      logger.debug(`[DEBUG] ${label}:`, typeof data === 'object' ? JSON.stringify(data, null, 2) : data);
    }
  },
  
  time: (label: string) => {
    if (debug.enabled) {
      console.time(`[PROFILE] ${label}`);
    }
  },
  
  timeEnd: (label: string) => {
    if (debug.enabled) {
      console.timeEnd(`[PROFILE] ${label}`);
    }
  },
  
  profile: async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
    if (debug.enabled) {
      debug.time(label);
      try {
        return await fn();
      } finally {
        debug.timeEnd(label);
      }
    }
    return fn();
  },
};
