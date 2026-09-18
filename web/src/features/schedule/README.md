# Schedule feature — preparation only, no implementation yet

This folder is a placeholder marking where the Schedule feature slice
lands. Per PHASE 2 scope, only the foundation (this repo's `app/`,
`services/`, `features/auth`, test/CI setup) is built in this pass.

Schedule itself — `api/`, `hooks/`, `components/`, `types.ts` — is
implemented as the next, separate, small commit after this foundation
is reviewed, using the domain-service convention below and the
CURRENT/TARGET/TABLES/RLS/ROLE/CRUD/VALIDATION/ERROR/EMPTY/TEST-MATRIX
write-up that belongs in `docs/SCHEDULE_MIGRATION.md`.

## Domain service convention (applies to every feature, starting here)

```
src/features/<name>/
  api/          — all Supabase calls for this feature (the only files
                  that import `services/supabase/client`)
  hooks/        — React hooks that call api/ and expose loading/error/
                  data state to components
  components/   — presentational + container components; call hooks/,
                  never api/ directly
  types.ts      — this feature's local types (not the placeholder
                  global Database type — see src/types/database.ts)
```

Rule: a React component is never an arbitrary Supabase query layer.
Anything beyond a trivial single-row read goes in `api/`, not inline
in a component's `useEffect`.
