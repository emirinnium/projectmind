import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

// Allowed test commands whitelist
const ALLOWED_COMMANDS = new Set([
  'node',
  'npm',
  'npx',
  'pnpm',
  'yarn',
  'python',
  'python3',
  'go',
  'cargo',
  'jest',
  'mocha',
  'vitest',
  'pytest',
]);

// Characters that could be used for shell injection
const DANGEROUS_CHARS = /[;&|`$(){}[\]<>!#*?\\]/;

export class SpawnValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpawnValidationError';
  }
}

/**
 * Validate and sanitize a test command before spawning.
 * @throws SpawnValidationError if command is potentially dangerous
 */
function validateCommand(testCommand: string): { cmd: string; args: string[] } {
  const parts = testCommand.trim().split(/\s+/);
  if (parts.length === 0 || !parts[0]) {
    throw new SpawnValidationError('Empty command');
  }

  const cmd = parts[0];
  const args = parts.slice(1);

  // Check for shell metacharacters in the command itself
  if (DANGEROUS_CHARS.test(cmd)) {
    throw new SpawnValidationError(`Command contains dangerous characters: ${cmd}`);
  }

  // Check against whitelist
  const cmdName = cmd.replace(/^.*[\\/]/, ''); // strip path
  if (!ALLOWED_COMMANDS.has(cmdName)) {
    throw new SpawnValidationError(
      `Command "${cmdName}" is not in the allowed list: ${Array.from(ALLOWED_COMMANDS).join(', ')}`
    );
  }

  // Validate arguments
  for (const arg of args) {
    if (DANGEROUS_CHARS.test(arg)) {
      throw new SpawnValidationError(`Argument contains dangerous characters: ${arg}`);
    }
  }

  return { cmd, args };
}

export interface TraceEvent {
  fromFunctionName: string;
  toFunctionName: string;
  workloadId: string;
  callCount?: number;
  staticMissed?: boolean;
}

export interface TraceResult {
  workloadId: string;
  events: TraceEvent[];
  durationMs: number;
  exitCode: number | null;
  error?: string;
}

/**
 * Run a test command and capture stdout/stderr for trace events.
 * The test runner should output JSON lines with trace events.
 */
export async function runTestTrace(
  testCommand: string,
  workloadId?: string
): Promise<TraceResult> {
  const startTime = Date.now();
  const id = workloadId || `trace-${startTime}`;
  const events: TraceEvent[] = [];
  let exitCode: number | null = null;
  let error: string | undefined;

  return new Promise((resolve) => {
    // Validate command before spawning
    let cmd: string;
    let args: string[];
    try {
      const validated = validateCommand(testCommand);
      cmd = validated.cmd;
      args = validated.args;
    } catch (e) {
      resolve({
        workloadId: id,
        events: [],
        durationMs: 0,
        exitCode: null,
        error: e instanceof Error ? e.message : String(e),
      });
      return;
    }

    // Only pass necessary environment variables (security: don't leak API keys)
    const safeEnv: Record<string, string> = {
      PROJECTMIND_TRACE_WORKLOAD: id,
      PATH: process.env.PATH || '',
      HOME: process.env.HOME || process.env.USERPROFILE || '',
    };
    // Add Node.js related env vars needed for test runners
    if (process.env.NODE_ENV) safeEnv.NODE_ENV = process.env.NODE_ENV;
    if (process.env.NODE_OPTIONS) safeEnv.NODE_OPTIONS = process.env.NODE_OPTIONS;

    const child = spawn(cmd, args, {
      cwd: process.cwd(),
      env: safeEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false, // Explicitly disable shell to prevent injection
    });

    child.stdout.on('data', (data) => {
      const text = data.toString();
      for (const line of text.split('\n')) {
        if (line.startsWith('{')) {
          try {
            const parsed = JSON.parse(line);
            if (parsed.type === 'trace' || parsed.fromFunctionName) {
              events.push({
                fromFunctionName: parsed.fromFunctionName,
                toFunctionName: parsed.toFunctionName,
                workloadId: parsed.workloadId || id,
                callCount: parsed.callCount,
                staticMissed: parsed.staticMissed,
              });
            }
          } catch {
            // ignore non-JSON lines
          }
        }
      }
    });

    child.stderr.on('data', (_data) => {
      // Capture stderr for debugging
    });

    child.on('close', (code) => {
      exitCode = code ?? null;
      if (exitCode !== 0) {
        error = `Test command exited with code ${exitCode}`;
      }
      resolve({
        workloadId: id,
        events,
        durationMs: Date.now() - startTime,
        exitCode,
        error,
      });
    });

    child.on('error', (err) => {
      error = err.message;
      resolve({
        workloadId: id,
        events,
        durationMs: Date.now() - startTime,
        exitCode: null,
        error,
      });
    });
  });
}

/**
 * Load trace events from a JSON file
 */
export function loadTraceFile(filePath: string): TraceEvent[] {
  if (!existsSync(filePath)) {
    throw new Error(`Trace file not found: ${filePath}`);
  }
  const content = readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(content);
  return Array.isArray(parsed) ? parsed : parsed.calls || parsed.events || [];
}

/**
 * Normalize trace events: deduplicate, aggregate call counts, etc.
 */
export function normalizeTraceEvents(events: TraceEvent[]): TraceEvent[] {
  const seen = new Map<string, TraceEvent>();

  for (const event of events) {
    const key = `${event.fromFunctionName}::${event.toFunctionName}::${event.workloadId}`;
    const existing = seen.get(key);
    if (existing) {
      existing.callCount = (existing.callCount || 1) + (event.callCount || 1);
      if (event.staticMissed) {
        existing.staticMissed = true;
      }
    } else {
      seen.set(key, { ...event });
    }
  }

  return Array.from(seen.values());
}
