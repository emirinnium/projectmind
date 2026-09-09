export interface ActionableErrorShape {
  code: string;
  summary: string;
  details?: string;
  location?: { path?: string; line?: number; column?: number; range?: [number, number] };
  cause?: 'validation' | 'filesystem' | 'stale-index' | 'network' | 'runtime' | 'unsupported';
  nextActions: string[];
  retryable: boolean;
  destructive: boolean;
  networkRequired: boolean;
}

interface PathSecurityLike extends Error {
  code: string;
  inputPath?: string;
}

export class ActionableProjectMindError extends Error {
  constructor(public readonly problem: ActionableErrorShape) {
    super(problem.summary);
    this.name = 'ActionableProjectMindError';
  }
}

/** Keep public diagnostics useful without echoing secrets or machine paths. */
export function sanitizeErrorText(value: string): string {
  return value
    .replace(/[\r\n\0]/g, ' ')
    .replace(/((?:api[_-]?key|token|secret|password)\s*[=:]\s*)([^\s,;]+)/gi, '$1[redacted]')
    .replace(/(?:[A-Za-z]:[\\/]|\\\\|\/)(?:[^\s"'`<>|]+[\\/])*[^\s"'`<>|]*/g, '[path]')
    .slice(0, 2000);
}

/** Convert a thrown public error into a stable MCP response payload. */
export function actionableMcpError(error: unknown): {
  isError: true;
  content: Array<{ type: 'text'; text: string }>;
} {
  return {
    isError: true,
    content: [
      { type: 'text', text: JSON.stringify({ success: false, error: toActionableError(error) }) },
    ],
  };
}

export function actionableError(
  code: string,
  summary: string,
  nextActions: string[],
  options: Omit<Partial<ActionableErrorShape>, 'code' | 'summary' | 'nextActions'> = {},
): ActionableProjectMindError {
  return new ActionableProjectMindError({
    code,
    summary: sanitizeErrorText(summary),
    nextActions: nextActions.map(sanitizeErrorText),
    retryable: options.retryable ?? false,
    destructive: options.destructive ?? false,
    networkRequired: options.networkRequired ?? false,
    ...options,
    details: options.details ? sanitizeErrorText(options.details) : undefined,
  });
}

export function toActionableError(error: unknown): ActionableErrorShape {
  if (error instanceof ActionableProjectMindError) {
    return {
      ...error.problem,
      summary: sanitizeErrorText(error.problem.summary),
      details: error.problem.details ? sanitizeErrorText(error.problem.details) : undefined,
      nextActions: error.problem.nextActions.map(sanitizeErrorText),
    };
  }
  if (error instanceof Error && isPathSecurityLike(error)) {
    const summaryByCode: Record<string, string> = {
      'empty-path': 'A required project path is empty.',
      'path-too-long': 'The project path is too long.',
      'nul-byte': 'The project path contains a NUL byte.',
      'control-character': 'The project path contains a control character.',
      'foreign-absolute-path': 'The path uses an absolute path convention from another platform.',
      'outside-project': 'The path escapes the configured project root.',
      'symlink-outside-project':
        'The path resolves through a symlink or junction outside the project root.',
      'ignored-path': 'The path is excluded by .pmignore.',
      'not-a-file': 'The requested project path is not an accessible file.',
      'file-too-large': 'The requested project file exceeds the configured size limit.',
    };
    return {
      code: `path.${error.code}`,
      summary: summaryByCode[error.code] ?? 'Project path was rejected.',
      details: 'The path was rejected before any file operation started.',
      location:
        error.inputPath && !isAbsolutePath(error.inputPath) ? { path: error.inputPath } : undefined,
      cause: 'filesystem',
      nextActions: ['Use a project-relative path inside PROJECTMIND_ROOT and retry.'],
      retryable: true,
      destructive: false,
      networkRequired: false,
    };
  }
  if (error instanceof Error) {
    return {
      code: 'projectmind.error',
      summary: sanitizeErrorText(error.message),
      cause: 'runtime',
      nextActions: ['Inspect the command context and retry after correcting the reported input.'],
      retryable: false,
      destructive: false,
      networkRequired: false,
    };
  }
  return {
    code: 'projectmind.unknown-error',
    summary: 'ProjectMind encountered an unknown error.',
    details: 'The error value was not an Error instance and was intentionally redacted.',
    cause: 'runtime',
    nextActions: ['Retry with PROJECTMIND_DEBUG=1 to collect a diagnostic trace.'],
    retryable: true,
    destructive: false,
    networkRequired: false,
  };
}

function isPathSecurityLike(error: Error): error is PathSecurityLike {
  return (
    typeof (error as unknown as { code?: unknown }).code === 'string' &&
    (error.name === 'PathSecurityError' || error.constructor.name === 'PathSecurityError')
  );
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || /^[\\/]{2}/.test(value);
}
