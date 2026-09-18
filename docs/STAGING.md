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
