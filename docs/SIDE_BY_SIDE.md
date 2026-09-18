# TeachyaED — Legacy/React coexistence model (PHASE 2)

## Model chosen

**Legacy remains the sole production entrypoint.** The React app
(`web/`) is a separate build, deployed (when it is deployed at all)
to a non-production path/host that no real user is routed to. GitHub
Pages' existing deploy of `index.html` at the repo's configured
domain is untouched by anything in this phase.

Concretely:

- `index.html` at the repo root continues to be served exactly as
  before. Nothing in `web/` is wired into that deploy.
- `web/` builds to `web/dist/` (see `web/vite.config.ts`, `base: './'`)
  as a fully separate static site. It is not copied into the repo
  root, not referenced from `index.html`, and not part of the
  existing GitHub Pages publish source.
- No production GitHub Pages configuration is changed in this phase.
  If/when a non-production preview of the React build is published
  (e.g. to verify it builds and runs), it goes to a separate path or
  a separate deploy target — never the domain real users hit — and
  that step is called out explicitly when it happens, not silently
  bundled into a docs/foundation commit.

## Why not both apps on one page

The two apps must not both try to own the same Supabase Auth session,
Realtime channel set, or browser storage on a single page load — two
Supabase clients racing to refresh the same auth token, or two
`onAuthStateChange` listeners both reacting to the same event, is a
correctness and security-adjacent hazard (e.g. divergent state about
who is "logged in"), not just a performance one. Keeping them on
fully separate origins/paths, each with exactly one Supabase client
instance active per page load, avoids this by construction.

## Explicit boundary

| | Legacy `index.html` | React `web/` |
|---|---|---|
| Production traffic | YES — all of it | NO |
| Deploy target | GitHub Pages, repo root, `main` branch | Not deployed to any user-facing URL in PHASE 2 |
| Supabase project | Production (`juwvlyrepwdcndkqiqna`) | Same project, same RLS — read/write behavior is identical since it's the same backend; only reachable non-production for now |
| Realtime/session ownership | Sole owner while it is the only deployed app | No conflict, because it is not deployed anywhere a session could overlap |

## When this changes

Only PHASE 7 (Canary + cutover) in `docs/REACT_MIGRATION_PLAN.md`
changes this model, and only after: staging exists and has been used
for the required runtime regression pass, a specific feature slice
has been implemented and tested, and that is called out as its own
explicit, reviewed step — never as a side effect of a foundation or
feature-implementation commit.
