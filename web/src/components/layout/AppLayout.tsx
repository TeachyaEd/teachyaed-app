import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '@/features/auth/hooks/useAuth';

/**
 * Minimal layout shell. Deliberately not a port of the legacy app's
 * full chrome/navigation — that belongs to whichever feature slice
 * needs it, ported on its own merits per docs/REACT_MIGRATION_PLAN.md.
 *
 * The Schedule nav link below is the one exception so far: Schedule
 * is PHASE 3A's implemented slice (docs/SCHEDULE_MIGRATION.md), so a
 * link to it is the minimum chrome needed to actually reach it.
 */
export function AppLayout({ children }: { children: ReactNode }) {
  const { status, profile, signOut } = useAuth();

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header style={{ padding: '0.75rem 1rem', borderBottom: '1px solid #ddd' }}>
        <strong>TeachyaED</strong>{' '}
        <span style={{ opacity: 0.6, fontSize: '0.85em' }}>(React preview — not production)</span>
        {status === 'signed_in' && (
          <>
            <nav style={{ display: 'inline-block', marginLeft: '1rem' }}>
              <Link to="/">Home</Link>{' '}
              <Link to="/schedule">Schedule</Link>
            </nav>
            <span style={{ float: 'right' }}>
              {profile?.role ?? 'unknown role'}{' '}
              <button type="button" onClick={() => void signOut()}>
                Log out
              </button>
            </span>
          </>
        )}
      </header>
      <main style={{ flex: 1, padding: '1rem' }}>{children}</main>
    </div>
  );
}
