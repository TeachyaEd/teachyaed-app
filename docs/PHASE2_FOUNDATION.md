# TeachyaED — PHASE 2 foundation: status and verification method

## What was built

`web/` — a Vite + React + TypeScript application, structured per
`docs/REACT_MIGRATION_PLAN.md`'s target architecture:

```
web/
  src/
    app/{router,providers,guards}
    features/auth/{api,hooks,components}   (+ features/schedule/, prep-only)
    components/{ui,layout}
    services/supabase/client.ts
    lib/{env.ts,errors.ts,observability.ts}
    types/database.ts
  tests/{unit,e2e}
  .github/workflows/ci-react.yml   (placed at repo root, not web/ — see below)
```

Covers, in order, the 10 required foundation pieces before Schedule:
env/config layer (`src/lib/env.ts`), Supabase client layer
(`src/services/supabase/client.ts`), auth/session bootstrap
(`src/features/auth/`), app providers (`src/app/providers/AppProviders.tsx`),
routing shell (`src/app/router/index.tsx`, HashRouter — reasoning in
`docs/REACT_MIGRATION_PLAN.md`), layout shell (`src/components/layout/AppLayout.tsx`),
error boundary (`src/components/layout/ErrorBoundary.tsx`), services
convention (`src/features/schedule/README.md`), test/CI foundation
(below).

## Important environment constraint — read before trusting any PASS claim

This scaffold was written in an environment with **no npm registry
access** (`npm install` / `npm create vite` both failed with a 403
from the outbound proxy — this is a sandbox network policy, not a
transient error). That means `npm install`, `tsc`, `eslint`, `vitest`,
and `vite build` could **not be run locally** to produce real
PASS/FAIL results for this scaffold before committing it.

Every file was written by hand against known, current Vite/React/TS/
Vitest/ESLint-flat-config conventions, and cross-checked for internal
consistency (import paths, `tsconfig` path aliases matching
`vite.config.ts`'s alias, etc.) — but "written correctly" is not the
same claim as "verified to build." Per this engagement's own
long-standing discipline (never trust "commit created" or "looks
right" as proof — verify), the real verification step is:

**`web/.github/workflows/ci-react.yml` runs on GitHub's own
infrastructure (which does have npm registry access) on every push —
typecheck, lint, unit tests, build, and the frontend security check
all run there for real.** That CI run's actual pass/fail result,
polled via the GitHub API after this foundation is committed, is the
first genuine PASS/FAIL evidence for this code — not a claim made in
this document.

One consequence: **no `package-lock.json` is committed yet**, because
generating a real one requires a working `npm install`. `ci-react.yml`
runs a plain `npm install` per job rather than relying on a lockfile-
keyed cache. Generating and committing a real lockfile (and re-
enabling proper CI caching) is a documented follow-up, not silently
skipped.

## GitHub Actions path constraint

GitHub only discovers workflow files at `.github/workflows/` under
the **repository root** — not under `web/.github/workflows/`. The
workflow file was authored at `web/.github/workflows/ci-react.yml`
locally for organizational clarity while drafting it, but is
committed to the repo at `.github/workflows/ci-react.yml` (repo
root), which is the only path GitHub Actions actually reads.

## Security-relevant choices made in this phase

- `src/services/supabase/client.ts` reads only `VITE_SUPABASE_URL` /
  `VITE_SUPABASE_ANON_KEY`, and is the only file that calls
  `createClient()` — see that file's own comments. `ci-react.yml`'s
  `build` job additionally greps the built `dist/` output for
  `service_role`/`SUPABASE_SERVICE`/private-key-shaped strings and
  fails the build if any are found, as a mechanical backstop.
- `src/types/database.ts` is an explicit placeholder (table names
  only, no invented columns) — see that file's header and
  `docs/REACT_MIGRATION_PLAN.md`. A read-only `information_schema`
  introspection query was drafted to generate real types safely, but
  the action of running it against the production Supabase SQL editor
  was blocked by this environment's own action-permission classifier
  (treated as a sensitive action). No attempt was made to route around
  that block — the documented-placeholder fallback was used instead,
  exactly as the instructions creating this phase allowed for.
- The production database baseline (`security/security_baseline.sql`)
  was **not re-run** in this phase. Nothing in PHASE 2 touches the
  database, RLS, Realtime, Storage, or Edge Functions — only new
  frontend source files and a new CI workflow were added — so per
  this engagement's own established rule ("only re-run a full security
  review if the trust boundary itself changes"), the existing baseline
  checkpoint (commits `d193597`/`a657b4c`, last verified 68/68 PASS,
  re-confirmed with no drift during the PHASE 0 Discovery re-check of
  Realtime channels) still stands. `ci-react.yml` documents exactly
  how/when the DB baseline runs going forward (manually, or against a
  future staging environment — never against production on every PR).
- `security/frontend_security_check.js` (existing repo tooling, not
  new) now runs automatically in CI against the legacy `index.html` on
  every push/PR that touches `web/**` or the workflow itself, via the
  `frontend-security-check` job — this is a new, additive safety net,
  not a replacement for manual review.

## What PHASE 2 foundation explicitly did NOT do

- Did not change `index.html`, GitHub Pages configuration, or any
  production-facing deploy.
- Did not run any SQL against the database (read-only or otherwise) —
  the one attempted read-only introspection query was blocked by the
  environment's permission classifier and was not retried by another
  route.
- Did not implement the Schedule feature — only its preparation
  document (`docs/SCHEDULE_MIGRATION.md`) and its folder convention
  (`web/src/features/schedule/README.md`).
- Did not add Playwright as a runnable dependency — `web/tests/e2e/`
  documents the intended structure and is explicitly marked
  `NOT RUN — staging unavailable`.
