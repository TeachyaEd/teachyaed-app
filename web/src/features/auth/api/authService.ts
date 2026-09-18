/**
 * Auth domain service.
 *
 * All Supabase calls related to session/profile identity live here,
 * not in components or the AuthProvider. This mirrors the legacy
 * app's `ensure_my_profile` RPC pattern (see
 * docs/MIGRATION_INVENTORY.md, "Auth / Invite / Session") so the
 * React and legacy apps derive identity from the same authoritative
 * server-side source, not from anything client-stored.
 *
 * Security invariant: the caller of this module must never treat
 * anything from localStorage, the URL, or client-supplied metadata
 * as role/identity. Only what this module reads back from Supabase
 * (auth.uid() and the server-side `profiles` row / `ensure_my_profile`
 * RPC result) is authoritative.
 */

import { supabase } from '@/services/supabase/client';
import { toAppError } from '@/lib/errors';
import { observability } from '@/lib/observability';
import type { Profile } from '../types';

export async function getCurrentUserId(): Promise<string | null> {
  const { data, error } = await supabase.auth.getSession();
  if (error) {
    observability.captureSupabaseRequestFailure({
      message: 'auth.getSession failed',
      context: { code: error.name },
    });
    throw toAppError(error);
  }
  return data.session?.user.id ?? null;
}

/**
 * Fetches (and, via the RPC, lazily provisions) the caller's own
 * profile row. Mirrors the legacy `ensure_my_profile()` RPC call —
 * see docs/MIGRATION_INVENTORY.md. Never accepts a userId parameter
 * from the caller: it always resolves identity server-side from the
 * current session, so there is no client-supplied id to spoof.
 */
export async function fetchOwnProfile(): Promise<Profile | null> {
  const { data: rpcData, error: rpcError } = await supabase.rpc('ensure_my_profile');
  if (rpcError) {
    observability.captureSupabaseRequestFailure({
      message: 'ensure_my_profile RPC failed',
      context: { code: rpcError.code ?? null },
    });
    throw toAppError(rpcError);
  }

  // The RPC's return shape is not asserted here (see
  // src/types/database.ts placeholder note). Fall back to a direct,
  // narrow select of the caller's own row if the RPC doesn't already
  // return a full profile — both paths are RLS-scoped to the caller.
  if (rpcData && typeof rpcData === 'object' && 'id' in rpcData) {
    return rpcData as Profile;
  }

  const { data: userData } = await supabase.auth.getUser();
  const uid = userData.user?.id;
  if (!uid) return null;

  const { data, error } = await supabase
    .from('profiles')
    .select('id, school_id, role')
    .eq('id', uid)
    .maybeSingle();

  if (error) {
    observability.captureSupabaseRequestFailure({
      message: 'profiles select failed',
      context: { code: error.code ?? null },
    });
    throw toAppError(error);
  }

  return (data as Profile | null) ?? null;
}

export async function signOut(): Promise<void> {
  const { error } = await supabase.auth.signOut();
  if (error) {
    observability.captureSupabaseRequestFailure({
      message: 'auth.signOut failed',
      context: { code: error.name },
    });
    throw toAppError(error);
  }
}

export function onAuthStateChange(
  callback: (userId: string | null) => void
): () => void {
  const { data } = supabase.auth.onAuthStateChange((_event, session) => {
    callback(session?.user.id ?? null);
  });
  return () => data.subscription.unsubscribe();
}
