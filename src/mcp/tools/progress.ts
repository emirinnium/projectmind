/**
 * MCP progress notification support (spec: notifications/progress).
 *
 * Clients that pass `_meta.progressToken` on a tools/call request receive
 * throttled progress updates while long-running operations (scan, debt
 * detection, ...) execute. Clients that did NOT opt in get a zero-cost
 * no-op reporter, so wiring this into every handler is free.
 */

/** Minimal structural view of the SDK RequestHandlerExtra we rely on. */
interface HandlerExtraLike {
  _meta?: { progressToken?: string | number };
  sendNotification?: (notification: unknown) => Promise<void>;
}

export type ProgressReporter = (progress: number, total: number, message?: string) => Promise<void>;

const MIN_INTERVAL_MS = 250;

/**
 * Build a progress reporter bound to the current tool-call request.
 *
 * Usage inside a tool handler:
 * ```ts
 * async (args, extra) => {
 *   const progress = createProgressReporter(extra, 'scan_project');
 *   await progress(0, 100, 'starting scan');
 *   ...
 *   await progress(100, 100, 'done');
 * }
 * ```
 *
 * Semantics:
 * - No-op (never throws, never sends) when the client supplied no
 *   progressToken or the transport cannot send notifications.
 * - Throttled to at most one notification per 250ms, EXCEPT the final
 *   call (progress >= total) which is always delivered so clients can
 *   close out their progress indicator deterministically.
 */
export function createProgressReporter(extra: unknown, _toolName: string): ProgressReporter {
  const e = (extra ?? {}) as HandlerExtraLike;
  const token = e._meta?.progressToken;
  const send = e.sendNotification;

  if (token === undefined || typeof send !== 'function') {
    return async () => {};
  }

  let lastSentAt = 0;

  return async (progress: number, total: number, message?: string): Promise<void> => {
    const now = Date.now();
    const isFinal = total > 0 && progress >= total;
    if (!isFinal && now - lastSentAt < MIN_INTERVAL_MS) {
      return;
    }
    lastSentAt = now;
    try {
      await send({
        method: 'notifications/progress',
        params: {
          progressToken: token,
          progress,
          ...(total > 0 ? { total } : {}),
          ...(message ? { message } : {}),
        },
      });
    } catch {
      // Progress is best-effort: a failing notification channel must never
      // break the underlying operation.
    }
  };
}

/** Convenience wrapper that always emits (bypasses throttle) — used for stage boundaries. */
export function createStageProgressReporter(extra: unknown, _toolName: string): ProgressReporter {
  const e = (extra ?? {}) as HandlerExtraLike;
  const token = e._meta?.progressToken;
  const send = e.sendNotification;

  if (token === undefined || typeof send !== 'function') {
    return async () => {};
  }

  return async (progress: number, total: number, message?: string): Promise<void> => {
    try {
      await send({
        method: 'notifications/progress',
        params: {
          progressToken: token,
          progress,
          ...(total > 0 ? { total } : {}),
          ...(message ? { message } : {}),
        },
      });
    } catch {
      // best-effort, see above
    }
  };
}
