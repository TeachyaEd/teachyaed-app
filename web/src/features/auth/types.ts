/**
 * Auth foundation types.
 *
 * `Profile` intentionally mirrors only what the legacy app treats as
 * authoritative identity: `auth.uid() -> profiles -> school_id/role`
 * (docs/MIGRATION_INVENTORY.md, "Auth / Invite / Session"). Column
 * names beyond id/school_id/role are not asserted here because the
 * real `profiles` schema was not introspected for this scaffold —
 * see src/types/database.ts. Extend this type only against a
 * verified column list, not by guessing.
 */

export type Role = 'owner' | 'admin' | 'teacher' | 'student' | (string & {});

export interface Profile {
  id: string;
  school_id: string | null;
  role: Role | null;
}

export type AuthStatus =
  | 'loading'
  | 'signed_out'
  | 'signed_in'
  | 'profile_error'
  | 'session_error';

export interface AuthState {
  status: AuthStatus;
  userId: string | null;
  profile: Profile | null;
  error: string | null;
}
