# TeachyaED — Staging Environment

> **2026-09-25 update: staging now exists and is in active use.** The
> "BLOCKED / NOT YET CREATED" status and the rest of this document below
> the banner are preserved as a historical record of the PHASE 0 discovery
> finding, but they are no longer accurate. Current state:
>
> - A second, real Supabase project exists: **teachyaed-staging**
>   (project ref `lqyetodkoxodwjyqxukq`), distinct from production
>   (`juwvlyrepwdcndkqiqna`). It carries its own `call_attempts` schema,
>   RLS policies and RPCs (`start_call`/`accept_call`/`decline_call`/
>   `end_call`/`fail_call`), applied and verified independently of
>   production.
> - A GitHub Actions workflow, `.github/workflows/staging-e2e.yml` on the
>   `call-attempts-architecture` branch, runs Playwright E2E specs against
>   staging (`workflow_dispatch`-only, not yet wired into required checks
>   on `main`). It covers P0 auth/session, schedule read, and the full
>   `call_attempts` calling flow (signalling, accept/media, reload
>   recovery, multi-tab, staleness), plus diagnostics.
> - Test identities exist as GitHub Actions repo secrets:
>   `STAGING_TEACHER_EMAIL`/`STAGING_TEACHER_PASSWORD`,
>   `STAGING_STUDENT_EMAIL`/`STAGING_STUDENT_PASSWORD`, and
>   `STAGING_SUPABASE_ANON_KEY`. **Still missing** (blocking the
>   recovery/staleness/stranger-security/concurrency gates specifically):
>   `STAGING_SERVICE_ROLE_KEY` (for fixture provisioning) and
>   `STAGING_STRANGER_EMAIL`/`STAGING_STRANGER_PASSWORD`.
> - Deploys remain manual for the legacy `index.html` client (GitHub web
>   upload UI to `main`, no CI-driven deploy pipeline yet) — that part of
>   the original finding below is still accurate.
>
> See `docs/ROLLBACK_READINESS.md` for the current production/staging
> client and Edge Function version state, and the CI workflow file itself
> for the exact job graph.

---

# TeachyaED — Staging Environment: STATUS = BLOCKED / NOT YET CREATED

No staging environment or CI pipeline currently exists for TeachyaED. This is stated plainly rather than substituted with production, per explicit instruction: if staging can't be created now, block the phases that require it instead of testing against production.

## Current state

- Single Supabase project, used for production only.
- Single deploy target: `main` branch → GitHub Pages. Deploys are manual, via the GitHub web-upload UI (no `git push`, no CI).
- No second Supabase project, no preview deploys, no automated test runner.

## What creating a staging environment would require

1. A second Supabase project (or a branch, if using Supabase's branching feature), with the schema/RLS/functions from `security/security_baseline.sql`'s expectations replicated exactly — this is itself a security-sensitive step and should be reviewed against `SECURITY_BASELINE.md` before being treated as trustworthy staging, not assumed equivalent to production by default.
2. Seed data / at least two test accounts (student, teacher, ideally owner/admin) per `RELEASE_SECURITY_TEMPLATE.md`'s runtime regression plan.
3. A deploy path (even a manual one) to a staging URL separate from the production GitHub Pages deploy, so React slices can be exercised end-to-end before touching production traffic.
4. Ideally, basic CI (lint/build/typecheck on PR) once the repo has a real build step (it doesn't today — no bundler, no `package.json`-driven build).

## What this blocks

- PHASE 1 of `REACT_MIGRATION_PLAN.md` (Staging + CI) — blocked until the above exists.
- PHASE 6 (Calls + Live Lessons + Exercise Sync) — blocked until the 12-scenario mixed-client runtime regression from `RELEASE_SECURITY_TEMPLATE.md` can be run on staging with real second accounts. This must not be run against production.

## What is NOT blocked by this

- PHASE 0 (discovery/planning, this document included).
- PHASE 2 scaffolding and PHASE 3 low-risk feature development, as long as any production cutover of those slices is held until basic staging exists — legacy stays authoritative for a slice until it's been exercised somewhere other than production first.

Setting up staging is not something to do silently as a side effect of a code change — it touches infrastructure and should be its own reviewed step, flagged here as the top blocker for the plan.

---

## Staging workstream checklist (added during PHASE 2)

Investigated in parallel with the PHASE 2 React foundation, per that
phase's instructions. Nothing below was executed — no external paid
resource or destructive infrastructure change was created. Each item
is tagged with who/what it actually needs.

### CAN BE AUTOMATED NOW (no new credentials, no user action to start)

- Scaffold a second Vite build target / env file convention for a
  staging Supabase URL + anon key (`.env.staging.example`) — purely
  local config, no live resource created by adding this file.
- Draft the staging schema/RLS replication script structure (i.e. a
  checklist/script skeleton for what needs to be copied from
  production, referencing `security/security_baseline.sql`'s
  expectations) — drafting the script is safe; running it against a
  real second project is not, and is not done here.
- Draft the Playwright `tests/e2e/` scenario files' *content* (not
  yet added as runnable specs — see `web/tests/e2e/README.md`) against
  the 12-row table in `security/RELEASE_SECURITY_TEMPLATE.md`.

### REQUIRES USER ACTION (a human with account/billing access decides)

- Create a second Supabase project ("staging"), or enable Supabase
  branching on the existing project if that fits the team's plan/
  billing tier — this is an account-level decision with a cost
  implication, not something to trigger automatically.
- Decide the staging deploy target: a second GitHub Pages source
  (e.g. a `staging` branch + a separate custom domain/path), Netlify/
  Vercel preview deploys, or similar — a hosting choice with its own
  account setup.
- Approve who gets access to staging test accounts / the staging
  Supabase dashboard.

### REQUIRES NEW CREDENTIALS/PROJECT (blocked on the above)

- A staging Supabase project ref + API keys (URL + anon key for the
  app; a separate, staging-scoped service-level credential for CI to
  run `security/security_baseline.sql` against staging only — never
  production, and never as a plain secret available to every PR, per
  `web/.github/workflows/ci-react.yml`'s "Database baseline" note).
- Staging Storage buckets (`materials`, `chat-files`) provisioned
  with the same public/private split as production
  (`SECURITY_BASELINE.md` §14-17).
- Staging Realtime configuration (same `realtime.messages` policies
  as production — `security_baseline.sql` checks these).
- Staging Edge Functions (`daily-room`, `invite-user`, `delete-user`)
  deployed with staging-scoped secrets, not production secrets.
- A safe reset procedure: a documented, idempotent way to wipe and
  reseed staging test data between test runs, so a failed run doesn't
  leave staging in a state that produces false positives/negatives on
  the next run. Not designed yet — flagged as a required deliverable
  of the staging setup, not assumed solved by "it's not production."

## Test account identity matrix (purpose only — no real accounts created)

| Role | Purpose |
|---|---|
| `owner` | Exercises owner-only flows: role changes, user deletion, salary/payment views, cross-class visibility within the school. |
| `admin` | Exercises admin-scoped management flows one level below owner. |
| `teacher` | Exercises class/lesson/homework authoring, live-lesson hosting, calling a student. |
| `student_a` | Primary student identity for same-school positive-path testing (schedule, homework, calls, chat, exsync as an authorized participant). |
| `student_b` | Second, distinct same-school student identity — required specifically for the negative-path Realtime tests in `RELEASE_SECURITY_TEMPLATE.md` (rows 5, 6, 8, 9): proving B cannot subscribe to or act on A's private channels. |
| `second_school_user` | An account belonging to a *different* school — required to re-confirm cross-tenant isolation (the core IDOR/BOLA invariant from the security audit chain) still holds through the React app, not just the legacy one. |

No production accounts are reused for any of the above. These are
purpose descriptions for staging-only seed accounts to be created once
a staging Supabase project exists.

---

## PHASE 2.1 note: React preview is not a staging environment

Explicit, because it is easy to conflate "the React app builds and I
can open it in a browser" with "we have staging":

- The React app (`web/`) at this point can be built locally and in CI
  (`.github/workflows/ci-react.yml`: typecheck, lint, unit tests,
  build, frontend security check all run against every push/PR). That
  is a build/test guarantee, not a runtime environment.
- It still talks to the **same single production Supabase project**
  described above (see `web/src/services/supabase/client.ts` and
  `web/.env.example`) — there is no second backend for it to point
  at yet. Running the built app anywhere still means every request
  hits production data, production RLS, production Realtime and
  production Storage.
- Therefore: until a dedicated staging Supabase project actually
  exists (the "REQUIRES USER ACTION" / "REQUIRES NEW
  CREDENTIALS/PROJECT" items above), the React app must **not** be
  used as an informal write-testing environment against production.
  No destructive or exploratory feature testing of React slices
  against production data — the same discipline that already applies
  to the legacy app.
- A manually hidden or non-public URL (an unlisted GitHub Pages path,
  a local `npm run dev` server, a preview build someone forgot to
  link from anywhere) is explicitly **not** equivalent to staging. It
  is still production data behind an obscure address, not an
  isolated environment — "hidden" is not a security or isolation
  boundary.
- Production's existing legacy `index.html` frontend remains the
  authoritative, user-facing entrypoint for all real usage until an
  explicit, reviewed cutover decision is made per slice
  (`REACT_MIGRATION_PLAN.md`'s "Side-by-side coexistence" model).
  Building/testing the React app in CI or locally does not change
  that.
