import { describe, it, expect } from 'vitest';
import { join, resolve } from 'node:path';
import {
  classifyPath,
  confineToProject,
  confinePathValueFlags,
  isPathInside,
  PathEscapesProjectError,
} from '../../src/mcp/tools/_shared.js';
import { isBlockedCliInvocation } from '../../src/mcp/tools/guard.js';

const ROOT = resolve(process.cwd(), 'fixtures-proj');

describe('K5: confineToProject (path traversal barrier)', () => {
  it('resolves relative in-project paths to absolute', () => {
    expect(confineToProject('src/a.ts', ROOT)).toBe(join(ROOT, 'src/a.ts'));
    expect(confineToProject('./x.ts', ROOT)).toBe(join(ROOT, 'x.ts'));
  });

  it('accepts absolute paths inside the root', () => {
    const abs = join(ROOT, 'lib', 'mod.ts');
    expect(confineToProject(abs, ROOT)).toBe(abs);
  });

  it('treats the root itself as inside', () => {
    expect(confineToProject(ROOT, ROOT)).toBe(ROOT);
  });

  it('rejects ../ relative escapes', () => {
    expect(() => confineToProject('../evil.txt', ROOT)).toThrow(PathEscapesProjectError);
    expect(() => confineToProject('src/../../evil.txt', ROOT)).toThrow(PathEscapesProjectError);
  });

  it('rejects absolute paths outside the root', () => {
    const outside = resolve(ROOT, '..', 'secret.txt');
    expect(() => confineToProject(outside, ROOT)).toThrow(PathEscapesProjectError);
  });

  it('rejects sibling-drive / home-directory absolute paths', () => {
    expect(() => confineToProject('/etc/passwd', ROOT)).toThrow(PathEscapesProjectError);
    expect(() => confineToProject('C:\\Windows\\System32\\drivers\\etc\\hosts', ROOT)).toThrow(PathEscapesProjectError);
  });
});

describe('K4: confinePathValueFlags (CLI -o / --output / --config escapes)', () => {
  it('rejects -o escaping the project root', () => {
    expect(() => confinePathValueFlags(['report', '-o', '../pwn.json'], ROOT)).toThrow(PathEscapesProjectError);
  });

  it('rejects the --output= form', () => {
    expect(() => confinePathValueFlags(['doctor', 'scan-health', `--output=${resolve(ROOT, '..', 'x.json')}`], ROOT)).toThrow(
      PathEscapesProjectError
    );
  });

  it('rejects --config pointing outside', () => {
    expect(() => confinePathValueFlags(['layers', '--config', '/etc/passwd'], ROOT)).toThrow(PathEscapesProjectError);
  });

  it('leaves safe argv untouched', () => {
    const safe = ['report', '--format', 'json', '-o', 'out/report.json', '--output=out2.json'];
    const copy = [...safe];
    expect(() => confinePathValueFlags(safe, ROOT)).not.toThrow();
    expect(safe).toEqual(copy);
  });

  it('ignores non-path flags', () => {
    expect(() => confinePathValueFlags(['churn', '--since', '30'], ROOT)).not.toThrow();
  });
});

describe('K3: isBlockedCliInvocation destructive subcommand coverage', () => {
  it('blocks doctor clean-debt (mutation hole closed)', () => {
    expect(isBlockedCliInvocation(['doctor', 'clean-debt'])).toBe(true);
    expect(isBlockedCliInvocation(['doctor', 'scan-health'])).toBe(false);
  });

  it('still blocks every pre-existing destructive vector', () => {
    expect(isBlockedCliInvocation(['debt', 'clear'])).toBe(true);
    expect(isBlockedCliInvocation(['project', 'delete'])).toBe(true);
    expect(isBlockedCliInvocation(['layers', '--auto-fix'])).toBe(true);
  });
});

describe('isPathInside boundary semantics', () => {
  it('handles root/child/outside triples', () => {
    const child = join(ROOT, 'a', 'b.ts');
    const outside = join(ROOT, '..', 'x');
    expect(isPathInside(ROOT, child)).toBe(true);
    expect(isPathInside(ROOT, ROOT)).toBe(true);
    expect(isPathInside(ROOT, outside)).toBe(false);
    // Prefix trick: /proj2 inside /proj must be false, not just startsWith.
    expect(isPathInside(resolve(process.cwd(), 'proj'), resolve(process.cwd(), 'proj2'))).toBe(false);
  });
});

describe('classifyPath (convention detection)', () => {
  it('detects drive-letter Windows absolutes (both slash styles)', () => {
    expect(classifyPath('C:\\x')).toBe('windows-absolute');
    expect(classifyPath('C:/x')).toBe('windows-absolute');
    expect(classifyPath('D:')).toBe('windows-absolute');
  });

  it('detects UNC absolutes (both slash styles)', () => {
    expect(classifyPath('\\\\server\\share')).toBe('windows-absolute');
    expect(classifyPath('//server/share')).toBe('windows-absolute');
  });

  it('detects POSIX absolutes', () => {
    expect(classifyPath('/x')).toBe('posix-absolute');
    expect(classifyPath('/usr/local/bin')).toBe('posix-absolute');
  });

  it('detects relative paths', () => {
    expect(classifyPath('rel/path')).toBe('relative');
    expect(classifyPath('./x')).toBe('relative');
    expect(classifyPath('../up')).toBe('relative');
    expect(classifyPath('C')).toBe('relative');
  });
});

describe('confineToProject cross-platform convention rejection', () => {
  it('rejects foreign-convention absolutes on ANY host', () => {
    expect(() => confineToProject('D:/evil', ROOT)).toThrow(PathEscapesProjectError);
    expect(() => confineToProject('\\\\server\\share\\x', ROOT)).toThrow(PathEscapesProjectError);
    expect(() => confineToProject('//server/share/x', ROOT)).toThrow(PathEscapesProjectError);
  });

  it('accepts same-convention in-project absolute paths', () => {
    const abs = join(ROOT, 'src', 'a.ts');
    expect(confineToProject(abs, ROOT)).toBe(abs);
  });

  it('still resolves backslash-free relative paths', () => {
    expect(confineToProject('src/a.ts', ROOT)).toBe(join(ROOT, 'src/a.ts'));
  });
});