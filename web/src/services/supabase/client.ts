/**
 * The single authoritative browser Supabase client.
 *
 * Nothing else in this codebase should call `createClient()`. Every
 * feature/service imports `supabase` from here. This makes it
 * possible to audit "does this app only ever talk to Supabase with
 * the public anon key" by reading one file.
 *
 * Security invariants (see SECURITY_BASELINE.md, unchanged by this
 * migration):
 *  - Only VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are read here.
 *  - This client is never given a service_role key.
 *  - Authorization is enforced server-side by RLS. This client
 *    (and anything built on it) is not a security boundary.
 */

import { createClient } from '@supabase/supabase-js';
import { getEnv } from '@/lib/env';
// NOTE: not wired as createClient<Database>(...) yet. src/types/database.ts
// is a placeholder (table names only, no real column types — see that
// file's header), and forcing it through the generic client parameter
// would produce misleading autocomplete/type-safety rather than real
// safety. Switch to createClient<Database>(...) once database.ts is
// regenerated from the real schema.

const env = getEnv();

export const supabase = createClient(env.supabaseUrl, env.supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});
