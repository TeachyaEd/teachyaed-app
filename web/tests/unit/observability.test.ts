import { describe, expect, it, vi } from 'vitest';
import { observability } from '@/lib/observability';

describe('observability', () => {
  it('redacts context keys that look like tokens/secrets before logging', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    observability.captureError({
      message: 'auth failed',
      context: { accessToken: 'eyJabc123', userId: 'u1', apiKey: 'sk_live_xyz' },
    });

    const loggedContext = spy.mock.calls[0]?.[2] as Record<string, unknown> | undefined;
    expect(loggedContext?.accessToken).toBe('[redacted]');
    expect(loggedContext?.apiKey).toBe('[redacted]');
    expect(loggedContext?.userId).toBe('u1');

    spy.mockRestore();
  });
});
