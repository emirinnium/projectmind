import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { confinePathValueFlags } from './_shared.js';

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
 *
 * K4: path-valued flags (`-o`, `--output`, `--config`, ...) are confined to
 * the project boundary BEFORE the child is spawned — `../` or absolute escapes
 * are rejected instead of silently writing/reading files outside the project.
 */
export function runCliCapture(
  argv: string[],
  opts: { timeoutMs?: number; projectRoot?: string } = {},
): Promise<CliCaptureResult> {
  const started = Date.now();
  const projectRoot = opts.projectRoot || process.env.PROJECTMIND_ROOT || process.cwd();

  try {
    confinePathValueFlags(argv, projectRoot);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return Promise.resolve({
      ok: false,
      exitCode: 1,
      durationMs: 0,
      stdout: '',
      stderr: `[blocked by ProjectMind guard] ${error}`,
    });
  }

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = import('node:child_process').then(({ spawn }) =>
      spawn(process.execPath, [CLI_JS, ...argv], {
        cwd: projectRoot,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      }),
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
        resolve({
          ok: false,
          exitCode: -2,
          durationMs: Date.now() - started,
          stdout: tail(stdout, 8000),
          stderr: tail(stderr, 2000),
        });
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
