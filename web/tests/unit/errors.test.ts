import { describe, expect, it } from 'vitest';
import { AppError, toAppError } from '@/lib/errors';

describe('toAppError', () => {
  it('passes an existing AppError through unchanged', () => {
    const original = new AppError('validation', 'bad input');
    expect(toAppError(original)).toBe(original);
  });

  it('maps a 401 auth error to a safe session-expired message', () => {
    const result = toAppError({ status: 401, message: 'jwt expired: eyJhbGciOi...' });
    expect(result.kind).toBe('auth');
    expect(result.userMessage).not.toMatch(/eyJ/); // never leak token-shaped strings
  });

  it('maps a PGRST116 not-found code', () => {
    const result = toAppError({ code: 'PGRST116', message: 'no rows' });
    expect(result.kind).toBe('not_found');
  });

  it('maps a 42501 insufficient_privilege code to forbidden, not the raw SQL error', () => {
    const result = toAppError({
      code: '42501',
      message: 'new row violates row-level security policy for table "profiles"',
    });
    expect(result.kind).toBe('forbidden');
    expect(result.userMessage).not.toMatch(/row-level security|SQL/i);
  });

  it('falls back to a generic safe message for unknown shapes', () => {
    const result = toAppError(new Error('some internal detail'));
    expect(result.kind).toBe('unknown');
    expect(result.userMessage).toBe('Something went wrong. Please try again.');
  });
});
