import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Vitest global teardown (F44): remove leftover temp databases
 * (tests/tmp-*.db*) so crashed/aborted runs cannot accumulate artifacts.
 * Test files clean up after themselves; this is only a safety net.
 * Retries briefly because Windows may release SQLite file handles lazily.
 */
export default async function globalTeardown(): Promise<void> {
  const dir = join(process.cwd(), 'tests');
  for (let attempt = 0; attempt < 3; attempt++) {
    let remaining = 0;
    try {
      for (const entry of readdirSync(dir)) {
        if (!/^tmp-.*\.db(-shm|-wal|-journal)?$/.test(entry)) continue;
        try {
          rmSync(join(dir, entry), { force: true });
        } catch {
          remaining++;
        }
      }
    } catch {
      return; // directory unreadable — nothing we can do
    }
    if (remaining === 0) return;
    await new Promise((r) => setTimeout(r, 150));
  }
}
