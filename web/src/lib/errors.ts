/**
 * Central error normalization.
 *
 * Every service/feature should funnel thrown errors through
 * `toAppError()` before showing anything to a user or handing it to
 * the Error Boundary / observability layer. This keeps two rules in
 * one place instead of scattered across every catch block:
 *
 *  1. Users only ever see a short, safe message — never a raw
 *     Postgres/Supabase error string, a stack trace, a JWT, or SQL.
 *  2. Developers still get the real underlying error via `cause`,
 *     for logging through the observability interface
 *     (src/lib/observability.ts), which itself never logs tokens.
 */

export type AppErrorKind =
  | 'auth'
  | 'network'
  | 'not_found'
  | 'validation'
  | 'forbidden'
  | 'unknown';

export class AppError extends Error {
  readonly kind: AppErrorKind;
  readonly userMessage: string;

  constructor(kind: AppErrorKind, userMessage: string, cause?: unknown) {
    super(userMessage, { cause });
    this.name = 'AppError';
    this.kind = kind;
    this.userMessage = userMessage;
  }
}

const DEFAULT_MESSAGE = 'Something went wrong. Please try again.';

/**
 * Best-effort classification of an unknown thrown value (Supabase
 * PostgrestError, AuthError, a network TypeError, or anything else)
 * into a safe AppError. Never rethrows the original message verbatim
 * to the user unless it already looks like a hand-authored, safe
 * validation message.
 */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;

  if (err && typeof err === 'object') {
    const maybe = err as { message?: unknown; status?: unknown; code?: unknown };

    // Supabase Auth errors carry a `status`; Postgrest errors carry a
    // `code` (e.g. PGRST116 not found, 42501 insufficient_privilege).
    if (typeof maybe.status === 'number' && maybe.status === 401) {
      return new AppError('auth', 'Your session has expired. Please sign in again.', err);
    }
    if (maybe.code === 'PGRST116') {
      return new AppError('not_found', 'The requested item could not be found.', err);
    }
    if (maybe.code === '42501') {
      return new AppError('forbidden', 'You do not have permission to do that.', err);
    }
  }

  if (err instanceof TypeError && /fetch|network/i.test(err.message)) {
    return new AppError('network', 'Could not reach the server. Check your connection.', err);
  }

  return new AppError('unknown', DEFAULT_MESSAGE, err);
}
