
import { existsSync, readFileSync } from 'node:fs';

import { join } from 'node:path';
import ts from 'typescript';

/**
 * Shared TypeScript language-service bootstrap for editor-grade commands
 * (refs = find references, def = go to definition). Normalizes Windows
 * backslashes so host keys match tsconfig file lists on any platform.
 */

export interface ProjectLanguageService {
  service: ts.LanguageService;
  /** Normalize a path the way the host keys its snapshots. */
  norm(p: string): string;
  dispose(): void;
}

export function createProjectLanguageService(
  projectRoot: string,
  includeFiles: string[] = []
): ProjectLanguageService | null {
  const tsconfigPath = join(projectRoot, 'tsconfig.json');
  if (!existsSync(tsconfigPath)) return null;

  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (configFile.error) return null;

  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, projectRoot);
  const options = { ...parsed.options, noEmit: true, skipLibCheck: true };

  const norm = (p: string): string => p.replace(/\\/g, '/');
  const snapshotCache = new Map<string, ts.IScriptSnapshot | undefined>();

  const scriptNames = new Set<string>(parsed.fileNames.map(norm));
  for (const f of includeFiles) scriptNames.add(norm(f));

  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => [...scriptNames],
    getScriptVersion: () => '0',
    getScriptSnapshot: (name) => {
      const key = norm(name);
      if (!snapshotCache.has(key)) {
        const text = ts.sys.readFile(key);
        snapshotCache.set(key, text === undefined ? undefined : ts.ScriptSnapshot.fromString(text));
      }
      return snapshotCache.get(key);
    },
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    getCompilationSettings: () => options,
    getDefaultLibFileName: (o) => ts.getDefaultLibFileName(o),
    getCurrentDirectory: () => projectRoot,
  };

  const service = ts.createLanguageService(host);
  return {
    service,
    norm,
    dispose: () => service.dispose(),
  };
}

/** Read a file's text through the same normalized layer. */
export function readSourceNormalized(projectRoot: string, filePath: string): { abs: string; text: string } | null {
  const abs = join(projectRoot, filePath);
  try {
    return { abs, text: readFileSync(abs, 'utf-8') };
  } catch {
    return null;
  }
}
