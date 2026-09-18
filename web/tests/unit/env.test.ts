import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('getEnv', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('throws a clear error when VITE_SUPABASE_URL is missing', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', '');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key');
    const { getEnv } = await import('@/lib/env');
    expect(() => getEnv()).toThrow(/VITE_SUPABASE_URL/);
  });

  it('throws a clear error when VITE_SUPABASE_ANON_KEY is missing', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', '');
    const { getEnv } = await import('@/lib/env');
    expect(() => getEnv()).toThrow(/VITE_SUPABASE_ANON_KEY/);
  });

  it('returns both values when present, and caches them', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key');
    const { getEnv } = await import('@/lib/env');
    const first = getEnv();
    expect(first).toEqual({
      supabaseUrl: 'https://example.supabase.co',
      supabaseAnonKey: 'anon-key',
    });
    expect(getEnv()).toBe(first); // cached, same reference
  });
});
