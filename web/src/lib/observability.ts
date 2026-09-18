/**
 * Observability interface (no vendor wired up yet).
 *
 * This is intentionally just an interface + a console-based default
 * implementation. Swapping in a real provider (Sentry, etc.) later
 * means writing one adapter here — nothing in `features/` or
 * `app/` should import a monitoring SDK directly.
 *
 * Hard rule: never pass a Supabase session, JWT, auth token, or raw
 * request/response payload into these functions. Pass identifiers
 * (user id, table name, channel name) and safe metadata only.
 */

export interface ObservabilityEvent {
  message: string;
  context?: Record<string, string | number | boolean | null | undefined>;
}

export interface Observability {
  captureError(event: ObservabilityEvent & { error?: unknown }): void;
  captureRealtimeFailure(event: ObservabilityEvent): void;
  captureStorageFailure(event: ObservabilityEvent): void;
  captureSupabaseRequestFailure(event: ObservabilityEvent): void;
}

const SENSITIVE_KEY_PATTERN = /token|jwt|password|secret|key$/i;

function sanitizeContext(
  context: ObservabilityEvent['context']
): Record<string, unknown> | undefined {
  if (!context) return undefined;
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    clean[key] = SENSITIVE_KEY_PATTERN.test(key) ? '[redacted]' : value;
  }
  return clean;
}

class ConsoleObservability implements Observability {
  captureError(event: ObservabilityEvent & { error?: unknown }): void {
    console.error('[observability:error]', event.message, sanitizeContext(event.context));
  }
  captureRealtimeFailure(event: ObservabilityEvent): void {
    console.error('[observability:realtime]', event.message, sanitizeContext(event.context));
  }
  captureStorageFailure(event: ObservabilityEvent): void {
    console.error('[observability:storage]', event.message, sanitizeContext(event.context));
  }
  captureSupabaseRequestFailure(event: ObservabilityEvent): void {
    console.error('[observability:supabase]', event.message, sanitizeContext(event.context));
  }
}

// Single instance for now. If a real provider is added later, this
// factory is the only line that changes.
export const observability: Observability = new ConsoleObservability();
