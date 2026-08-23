import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL_DIR = dirname(fileURLToPath(import.meta.url)); // dist/mcp/tools
const CLI_JS = join(TOOL_DIR, '..', '..', 'cli.js'); // dist/cli.js

export interface CliCaptureResult {
  ok: boolean;
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
}

function tail(s: string, n: number): string {
  return s.length > n ? '…' + s.slice(-n) : s;
}

/**
 * Execute the ProjectMind CLI with an argv vector and capture output.
 * Single canonical implementation shared by `run_cli` and the generated
 * CLI-parity tools. shell:false everywhere; argv array only.
 */
export function runCliCapture(
  argv: string[],
  opts: { timeoutMs?: number; projectRoot?: string } = {}
): Promise<CliCaptureResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = import('node:child_process').then(({ spawn }) =>
      spawn(process.execPath, [CLI_JS, ...argv], {
        cwd: opts.projectRoot || process.env.PROJECTMIND_ROOT || process.cwd(),
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      })
    );

    child.then((child_) => {
      const t = setTimeout(() => {
        child_.kill();
        resolve({
          ok: false,
          exitCode: -1,
          durationMs: Date.now() - started,
          stdout: tail(stdout, 8000),
          stderr: tail(stderr + '\n[timeout]', 2000),
        });
      }, opts.timeoutMs ?? 120_000);

      child_.stdout?.on('data', (d) => {
        stdout += d.toString();
        if (stdout.length > 200_000) stdout = stdout.slice(-200_000);
      });
      child_.stderr?.on('data', (d) => {
        stderr += d.toString();
        if (stderr.length > 40_000) stderr = stderr.slice(-40_000);
      });
      child_.on('error', () => {
        clearTimeout(t);
        resolve({ ok: false, exitCode: -2, durationMs: Date.now() - started, stdout: tail(stdout, 8000), stderr: tail(stderr, 2000) });
      });
      child_.on('exit', (c) => {
        clearTimeout(t);
        resolve({
          ok: c === 0,
          exitCode: c ?? -1,
          durationMs: Date.now() - started,
          stdout: tail(stdout, 8000),
          stderr: tail(stderr, 2000),
        });
      });
    });
  });
}
