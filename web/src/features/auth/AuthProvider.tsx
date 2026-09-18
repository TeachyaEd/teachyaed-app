import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
 *
 * PHASE 2.1 stale-async hardening: React 19 + StrictMode double-
 * invokes this component's effects in development, and in production
 * a fast-following Supabase auth event can legitimately start a
 * second identity load before the first one has resolved. Every
 * identity load (mount bootstrap, onAuthStateChange, manual
 * `refresh()`) is tagged with a monotonically increasing
 * `generationRef` counter captured at the moment the load STARTS.
 * Before any of those loads commits its result via setState, it
 * re-checks that its captured generation still equals
 * `generationRef.current` (i.e. no newer load has started since) and
 * that `mountedRef.current` is still true. A slower, older load can
 * therefore never overwrite a newer one, and no load can update state
 * after unmount — see docs/AUTH_PARITY.md for the scenario this
 * defends against.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(AUTH_LOADING_STATE);

  const generationRef = useRef(0);
  const mountedRef = useRef(true);

  const loadForUser = useCallback(async (userId: string | null, generation: number) => {
    const isCurrent = () => mountedRef.current && generationRef.current === generation;

    if (!userId) {
      if (isCurrent()) {
        setState({ status: 'signed_out', userId: null, profile: null, error: null });
      }
      return;
    }
    if (isCurrent()) {
      setState((prev) => ({ ...prev, status: 'loading', userId }));
    }
    try {
      const profile = await fetchOwnProfile();
      if (isCurrent()) {
        setState({ status: 'signed_in', userId, profile, error: null });
      }
    } catch (err) {
      const appErr = toAppError(err);
      observability.captureError({ message: 'profile load failed', error: appErr, context: { userId } });
      if (isCurrent()) {
        setState({ status: 'profile_error', userId, profile: null, error: appErr.userMessage });
      }
    }
  }, []);

  // Shared by both the mount-time bootstrap (called from inside the
  // effect below) and the consumer-facing `refresh()` action. Resolves
  // the current Supabase session and loads the matching profile, all
  // guarded by the `generation` the caller captured before starting.
  const resolveSessionAndLoad = useCallback(async (generation: number) => {
    try {
      const userId = await getCurrentUserId();
      await loadForUser(userId, generation);
    } catch (err) {
      const appErr = toAppError(err);
      if (mountedRef.current && generationRef.current === generation) {
        setState({ status: 'session_error', userId: null, profile: null, error: appErr.userMessage });
      }
    }
  }, [loadForUser]);

  const refresh = useCallback(async () => {
    const generation = ++generationRef.current;
    await resolveSessionAndLoad(generation);
  }, [resolveSessionAndLoad]);

  const signOut = useCallback(async () => {
    generationRef.current += 1;
    await signOutService();
    if (mountedRef.current) {
      setState({ status: 'signed_out', userId: null, profile: null, error: null });
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;

    // Data-fetching effects should define and invoke their async work
    // as a function declared INSIDE the effect body (not call out to
    // an externally-defined useCallback directly) so the work is
    // structurally tied to this effect run — see
    // react-hooks/set-state-in-effect and
    // https://react.dev/learn/you-might-not-need-an-effect. The actual
    // session-resolving/profile-loading logic still lives in the
    // shared, generation-guarded `resolveSessionAndLoad`/`loadForUser`
    // above; this just gives the effect its own clearly-scoped entry
    // point.
    async function bootstrap() {
      const generation = ++generationRef.current;
      await resolveSessionAndLoad(generation);
    }
    void bootstrap();

    const unsubscribe = onAuthStateChange((userId) => {
      if (!mountedRef.current) return;
      const generation = ++generationRef.current;
      void loadForUser(userId, generation);
    });

    return () => {
      mountedRef.current = false;
      unsubscribe();
    };
    // resolveSessionAndLoad/loadForUser are stable via useCallback;
    // this effect is intentionally session-lifecycle-only and must
    // run once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = useMemo(
    () => ({ ...state, signOut, refresh }),
    [state, signOut, refresh]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
