import type { ReactNode } from 'react';
import { useAuth } from '@/features/auth/hooks/useAuth';

/**
 * Minimal layout shell. Deliberately not a port of the legacy app's
 * full chrome/navigation — that belongs to whichever feature slice
 * needs it, ported on its own merits per docs/REACT_MIGRATION_PLAN.md.
 */
export function AppLayout({ children }: { children: ReactNode }) {
  const { status, profile, signOut } = useAuth();

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header style={{ padding: '0.75rem 1rem', borderBottom: '1px solid #ddd' }}>
        <strong>TeachyaED</strong>{' '}
        <span style={{ opacity: 0.6, fontSize: '0.85em' }}>(React preview — not production)</span>
        {status === 'signed_in' && (
          <span style={{ float: 'right' }}>
            {profile?.role ?? 'unknown role'}{' '}
            <button type="button" onClick={() => void signOut()}>
              Log out
            </button>
          </span>
        )}
      </header>
      <main style={{ flex: 1, padding: '1rem' }}>{children}</main>
    </div>
  );
}
