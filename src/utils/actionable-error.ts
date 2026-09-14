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
  const urls: string[] = [];
  const protectedText = value.replace(/https?:\/\/[^\s"'`<>|]+/gi, (url) => {
    const marker = `\uE000PMURL${urls.length}\uE001`;
    urls.push(url);
    return marker;
  });
  const sanitized = protectedText
    .replace(/[\r\n\0]/g, ' ')
    .replace(/((?:api[_-]?key|token|secret|password)\s*[=:]\s*)([^\s,;]+)/gi, '$1[redacted]')
    .replace(/(?:[A-Za-z]:[\\/]|\\\\|\/)(?:[^\s"'`<>|]+[\\/])*[^\s"'`<>|]*/g, '[path]')
    .slice(0, 2000);
  return sanitized.replace(
    /\uE000PMURL(\d+)\uE001/g,
    (_match, index: string) => urls[Number(index)] ?? '[url]',
  );
}

/** Convert a thrown public error into a stable MCP response payload. */
export function actionableMcpError(error: unknown): {
  isError: true;
  nextAction: string;
  content: Array<{ type: 'text'; text: string }>;
} {
  const problem = toActionableError(error);
  const nextAction = problem.nextActions[0] ?? 'Retry after correcting the request.';
  return {
    isError: true,
    // Additive compatibility field for clients that consumed the old
    // top-level nextAction while the structured error remains in content.
    nextAction,
    content: [
      { type: 'text', text: JSON.stringify({ success: false, error: problem, nextAction }) },
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
    const classification = classifyError(error.message);
    return {
      code: 'projectmind.error',
      summary: sanitizeErrorText(error.message),
      details: classification.details,
      cause: classification.cause,
      nextActions: classification.nextActions,
      retryable: classification.retryable,
      destructive: false,
      networkRequired: classification.networkRequired,
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

interface ErrorClassification {
  cause: NonNullable<ActionableErrorShape['cause']>;
  details: string;
  nextActions: string[];
  retryable: boolean;
  networkRequired: boolean;
}

/** Classify legacy Error-only handlers without weakening their compatibility. */
function classifyError(message: string): ErrorClassification {
  const normalized = message.toLowerCase();
  if (/git revision|git ref|revision selector/.test(normalized)) {
    return {
      cause: 'validation',
      details: 'Git range selectors are validated before any repository command is started.',
      nextActions: [
        'Provide valid Git revisions (for example HEAD~1 and HEAD) without whitespace or shell syntax.',
      ],
      retryable: true,
      networkRequired: false,
    };
  }
  if (/stale|out[- ]of[- ]date|refresh.*index|rescan/.test(normalized)) {
    return {
      cause: 'stale-index',
      details: 'The operation depends on graph or source state that is no longer current.',
      nextActions: ['Run pm scan --incremental, then retry the command.'],
      retryable: true,
      networkRequired: false,
    };
  }
  if (
    /timed out|timeout|econn|fetch failed|api .*\b(?:4|5)\d\d\b|network|socket/.test(normalized)
  ) {
    return {
      cause: 'network',
      details: 'The operation depends on an external service or network connection.',
      nextActions: ['Check network access and provider credentials, then retry.'],
      retryable: true,
      networkRequired: true,
    };
  }
  if (/resource busy|locked|\bebusy\b|\beperm\b/.test(normalized)) {
    return {
      cause: 'filesystem',
      details: 'Another process may still hold the target file or its SQLite sidecars open.',
      nextActions: [
        'Close other ProjectMind/MCP processes using this project, then retry the operation.',
      ],
      retryable: true,
      networkRequired: false,
    };
  }
  if (/not found|enoent|cannot read|permission denied|is not a file|directory/.test(normalized)) {
    return {
      cause: 'filesystem',
      details: 'A required local file or directory could not be read.',
      nextActions: ['Check that the path exists, is readable, and is inside the project root.'],
      retryable: true,
      networkRequired: false,
    };
  }
  if (/invalid|must be|required|expected|schema|argument|option|between .* and/.test(normalized)) {
    return {
      cause: 'validation',
      details: 'The request did not satisfy the command or tool input contract.',
      nextActions: ['Correct the reported input and retry.'],
      retryable: true,
      networkRequired: false,
    };
  }
  if (/unsupported|unavailable|not implemented|cannot .* provider/.test(normalized)) {
    return {
      cause: 'unsupported',
      details: 'The requested operation is not available in the current configuration.',
      nextActions: ['Use a supported operation or enable the required optional provider.'],
      retryable: false,
      networkRequired: false,
    };
  }
  return {
    cause: 'runtime',
    details: 'The operation failed after its input and path checks completed.',
    nextActions: ['Inspect the command context and retry after correcting the reported input.'],
    retryable: false,
    networkRequired: false,
  };
}
