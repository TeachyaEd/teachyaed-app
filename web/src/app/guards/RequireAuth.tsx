import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '@/features/auth/hooks/useAuth';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';

/**
 * UX-ONLY guard. This decides what the user sees, not what they are
 * allowed to do — it hides/redirects nav, nothing more. The actual
 * authorization boundary is RLS on the Supabase side (see
 * SECURITY_BASELINE.md's golden rule). Never extend this component
 * to gate a privileged write client-side "because the guard already
 * checked" — it did not, and it cannot.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();

  if (status === 'loading') return <LoadingSpinner label="Checking your session…" />;
  if (status === 'signed_out') return <Navigate to="/login" replace />;
  if (status === 'session_error' || status === 'profile_error') {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}
