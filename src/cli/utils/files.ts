import { existsSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { loadConfig } from '@/utils/config.js';
import { getProjectIgnorePatterns, isIgnoredRelativePath } from '@/utils/ignore.js';

export async function getFilesToCheck(path: string): Promise<string[]> {
  const fg = await import('fast-glob');
  const glob = fg.default ?? fg;
  const projectRoot = resolve(loadConfig().projectRoot);
  const ignorePatterns = getProjectIgnorePatterns(projectRoot);
  const target = isAbsolute(path) ? resolve(path) : resolve(projectRoot, path);
  const relativeTarget = relative(projectRoot, target).replace(/\\/g, '/');

  if (relativeTarget.startsWith('..') || relativeTarget === '..') return [];

  if (existsSync(target) && statSync(target).isFile()) {
    return isIgnoredRelativePath(relativeTarget, ignorePatterns) ? [] : [target];
  }
  const pattern =
    relativeTarget && relativeTarget !== '.'
      ? `${relativeTarget}/**/*.{ts,js,tsx,jsx,mjs,cjs}`
      : '**/*.{ts,js,tsx,jsx,mjs,cjs}';
  return glob([pattern], {
    cwd: projectRoot,
    ignore: ignorePatterns,
    absolute: true,
  });
}
