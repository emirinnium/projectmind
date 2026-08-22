import { existsSync, statSync } from 'node:fs';

export async function getFilesToCheck(path: string): Promise<string[]> {
  const fg = await import('fast-glob');
  const glob = fg.default ?? fg;
  
  if (existsSync(path) && statSync(path).isFile()) {
    return [path];
  }
  return glob([`${path}/**/*.{ts,js,tsx,jsx}`], {
    ignore: ['**/node_modules/**', '**/dist/**', '**/dist-tests/**', '**/coverage/**'],
    absolute: true,
  });
}
