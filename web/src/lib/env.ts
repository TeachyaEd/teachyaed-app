/**
 * Environment/config layer.
 *
 * Reads only VITE_-prefixed variables (Vite inlines these into the
 * client bundle at build time — anything read here is public). This
 * module is the single place that touches `import.meta.env`, so a
 * missing/misconfigured variable fails loudly at startup instead of
 * silently producing a broken Supabase client somewhere deep in a
 * feature.
 *
 * Do NOT add anything here that isn't safe to ship to every browser:
 * no service_role key, no database password, no admin/server secret.
 * See docs/REACT_MIGRATION_PLAN.md ("Supabase client").
 */

export interface AppEnv {
  supabaseUrl: string;
  supabaseAnonKey: string;
}

function readRequired(name: string, value: string | undefined): string {
  if (!value || value.trim() === '') {
    throw new Error(
      `Missing required environment variable "${name}". Copy .env.example to .env.local and fill it in.`
    );
  }
  return value;
}

let cachedEnv: AppEnv | null = null;

export function getEnv(): AppEnv {
  if (cachedEnv) return cachedEnv;

  const supabaseUrl = readRequired(
    'VITE_SUPABASE_URL',
    import.meta.env.VITE_SUPABASE_URL
  );
  const supabaseAnonKey = readRequired(
    'VITE_SUPABASE_ANON_KEY',
    import.meta.env.VITE_SUPABASE_ANON_KEY
  );

  cachedEnv = { supabaseUrl, supabaseAnonKey };
  return cachedEnv;
}
