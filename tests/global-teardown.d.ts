/**
 * Vitest global teardown (F44): remove leftover temp databases
 * (tests/tmp-*.db*) so crashed/aborted runs cannot accumulate artifacts.
 * Test files clean up after themselves; this is only a safety net.
 * Retries briefly because Windows may release SQLite file handles lazily.
 */
export default function globalTeardown(): Promise<void>;
//# sourceMappingURL=global-teardown.d.ts.map