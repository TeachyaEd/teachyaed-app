# TeachyaED — Auth foundation: legacy vs React parity

Compares the legacy `index.html` auth flow (per `docs/MIGRATION_INVENTORY.md`,
"Auth / Invite / Session") against the new `web/src/features/auth`
foundation. This is a foundation-level comparison — it does not cover
the invite/password-set UX (`checkInviteToken`, `setInvitePassword`),
which is out of scope for PHASE 2 (see `web/src/features/auth/components/LoginPage.tsx`).

| Behavior | LEGACY | REACT | PARITY |
|---|---|---|---|
| Session recovery on load | Reads Supabase Auth's persisted session on page load, then calls `ensure_my_profile`-style lookup before rendering the authenticated UI | `AuthProvider` calls `supabase.auth.getSession()` on mount, then `ensure_my_profile` RPC (same call) before rendering | MATCH — same underlying Supabase Auth session store, same RPC |
| Initial loading state | Shows a loading state until session + profile are resolved | `status: 'loading'` until both are resolved; `RequireAuth` renders `<LoadingSpinner>` | MATCH |
| Logged-out state | Redirects to login/invite screen | `RequireAuth` redirects to `/login` (React Router) | MATCH in effect; LEGACY's exact login/invite screen UX is not ported — React's `/login` is a minimal foundation screen only |
| Logged-in state | Renders app shell with role/school from `profiles` | `status: 'signed_in'`, `profile.role` / `profile.school_id` available via `useAuth()` | MATCH |
| Profile lookup | `ensure_my_profile()` RPC (lazily provisions + returns row) | Same RPC, called from `features/auth/api/authService.ts`, with a direct `profiles` select as fallback if the RPC's return shape doesn't already include an id | MATCH on the primary path; fallback path is new (defensive, not a behavior change users can observe) |
| Role lookup | From the `profiles` row returned above | Same | MATCH |
| School lookup | From the `profiles` row returned above (`school_id`) | Same | MATCH |
| Logout | Calls Supabase Auth sign-out, clears local UI state | `supabase.auth.signOut()` via `authService.signOut()`, then local state reset to `signed_out` | MATCH |
| Auth refresh | Supabase client's `autoRefreshToken` handles token refresh transparently | Same (`autoRefreshToken: true` in `services/supabase/client.ts`), plus `onAuthStateChange` listener updates React state on any auth event | MATCH — React additionally reacts to auth state changes explicitly, which legacy does implicitly through its own event wiring; no behavior divergence for the user |
| Invalid/expired session | Treated as logged-out; any RLS 401 on a subsequent call surfaces as "please sign in again" | `toAppError()` maps a 401 to `AppError('auth', 'Your session has expired...')`; `AuthProvider` sets `status: 'session_error'` and `RequireAuth` redirects to `/login` | MATCH in outcome (redirect to login on invalid session); exact copy of the shown message is not asserted to match legacy verbatim |

## What is explicitly NOT claimed

This table does not claim the React `/login` screen or app shell match
the legacy UX pixel-for-pixel, nor that every legacy auth edge case
(e.g. specific invite-token flows) has been ported. It claims only
that the **authoritative identity chain and its lifecycle states**
match: `auth.uid() → server-backed profile → school_id → role`,
loading/signed-out/signed-in/error states, and logout/refresh
behavior. No behavior was silently altered.

## Security invariant (unchanged)

Neither implementation ever treats `localStorage`, a URL parameter, or
client-supplied metadata as authoritative role/identity. Route guards
(`RequireAuth`) are UX-only. RLS is the actual security boundary, on
both the legacy and React paths, against the same Supabase project.
