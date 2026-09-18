import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { fetchOwnProfile, getCurrentUserId, onAuthStateChange, signOut as signOutService } from './api/authService';
import { AuthContext, AUTH_LOADING_STATE } from './AuthContext';
import type { AuthState } from './types';
import { toAppError } from '@/lib/errors';
import { observability } from '@/lib/observability';

/**
 * Establishes: session, current profile, school, role, loading
 * state, logout, session refresh — and nothing more. See
 * docs/AUTH_PARITY.md for the legacy-vs-React comparison this
 * foundation is required to match, and SECURITY_BASELINE.md for why
 * `profile.role` / `profile.school_id` here are informational for
 * UX only, never an authorization decision by themselves.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(AUTH_LOADING_STATE);

  const loadForUser = useCallback(async (userId: string | null) => {
    if (!userId) {
      setState({ status: 'signed_out', userId: null, profile: null, error: null });
      return;
    }
    setState((prev) => ({ ...prev, status: 'loading', userId }));
    try {
      const profile = await fetchOwnProfile();
      setState({ status: 'signed_in', userId, profile, error: null });
    } catch (err) {
      const appErr = toAppError(err);
      observability.captureError({ message: 'profile load failed', error: appErr, context: { userId } });
      setState({ status: 'profile_error', userId, profile: null, error: appErr.userMessage });
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const userId = await getCurrentUserId();
      await loadForUser(userId);
    } catch (err) {
      const appErr = toAppError(err);
      setState({ status: 'session_error', userId: null, profile: null, error: appErr.userMessage });
    }
  }, [loadForUser]);

  const signOut = useCallback(async () => {
    await signOutService();
    setState({ status: 'signed_out', userId: null, profile: null, error: null });
  }, []);

  useEffect(() => {
    let cancelled = false;

    void refresh();

    const unsubscribe = onAuthStateChange((userId) => {
      if (cancelled) return;
      void loadForUser(userId);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
    // refresh/loadForUser are stable via useCallback; this effect is
    // intentionally session-lifecycle-only and must run once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = useMemo(
    () => ({ ...state, signOut, refresh }),
    [state, signOut, refresh]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
