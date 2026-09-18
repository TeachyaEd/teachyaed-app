# E2E tests — structure prepared, NOT RUN (staging unavailable)

This directory holds the intended Playwright layout for the runtime
scenarios in `security/RELEASE_SECURITY_TEMPLATE.md` (the 12-row
"Runtime Security Regression" table) once a staging environment
exists (`docs/STAGING.md`).

```
tests/e2e/
  auth.spec.ts        — session bootstrap, expired session, logout
  schedule.spec.ts     — Schedule CRUD, role-aware UI (after the
                          Schedule feature slice is implemented)
  playwright.config.ts — added once staging is reachable; deferred
                          for now because there is nowhere safe to
                          point it (never run against production)
```

No `.spec.ts` files or Playwright config are added yet. Adding a
Playwright config with no reachable, safe target would either point
at production (not allowed — see `docs/STAGING.md`) or silently do
nothing, which is worse than being explicit.

Status: **NOT RUN — staging unavailable.**

This is not a gap being hidden — it is the same evidence gap already
tracked in `security/RELEASE_SECURITY_TEMPLATE.md`, extended to cover
the React app once it exists. It closes when `docs/STAGING.md`'s
checklist is completed and a staging Supabase project + staging
deploy of this app both exist.
