# tests/legacy — regression coverage for root `index.html`

Scope: the **production entrypoint**, root `index.html` in this repo. Never
`/web` — the React app under `web/` is a separate, not-yet-production
application (see `docs/SIDE_BY_SIDE.md`) and must not be used as a substitute
for testing legacy production, per `docs/STAGING.md`'s own caution.

## What's here today (Phase 2 — implemented)

- `static-audit.mjs` — a read-only, dependency-free Node script that inspects
  `index.html` as text and fails on specific known-dangerous regressions.
  No network access, no DB access, no browser. Safe to run on every PR/push
  touching `index.html`, with zero secrets and zero staging dependency.
- `inventory.json` — the machine-readable Phase 1 test inventory: every
  user-facing production workflow, grouped by category, classified P0/P1/P2,
  and tagged `"layer": "static"` (covered here) or `"layer": "e2e"` (planned,
  not yet implemented — see below).

Run it locally:

```sh
node tests/legacy/static-audit.mjs            # audits ../../index.html
node tests/legacy/static-audit.mjs path/to/index.html
```

Exit code `0` = all checks passed. Exit code `1` = at least one regression
detected — do not deploy until resolved or the check is confirmed stale (see
"On false positives" below).

### Why structural checks, not line numbers

Every check extracts the specific function body or DB-call statement it cares
about (via brace/paren balancing keyed on function or table name), then
inspects only that extracted text. This survives unrelated reformatting or
reordering elsewhere in the file, and avoids the false positives a proximity
window produced during manual review this session (e.g. an unrelated
`school_id` filter on a neighboring `profiles` lookup being mistaken for a
`call_signals.school_id` reference just because it appeared nearby).

### Relationship to `security/frontend_security_check.js`

`static-audit.mjs` shells out to `security/frontend_security_check.js` as its
first check rather than re-implementing its private:true / channel-split /
forbidden-ring-handler checks. That script is literal-anchor based by
design — anchors are exact strings from a specific past security patch, and
a mismatch is reported as "stale check," never silently treated as pass. If a
future legitimate refactor changes one of its anchor strings (as happened
with the `declineCall()` rewrite in this same session — the anchor for the
decline-sender channel needed updating because the underlying variable name
legitimately changed from `S.pendingCallerId` to a captured local), update
the anchor in that file alongside the code change, in the same PR. Do not
delete or weaken an anchor to make a real regression pass.

### On false positives

If a check fails after a change you believe is legitimate (not a
regression), do not weaken the check to make it pass. Either:
1. The change is a real regression — fix the application code, not the test.
2. The check's structural assumption is now wrong for a legitimate reason —
   update the check itself, in the same PR/commit as the code change, with a
   comment explaining why, so the diff makes the reasoning reviewable.

Never delete a check to silence a failure without one of the two above.

## What's not here yet (Phase 3 — not implemented)

`inventory.json` entries tagged `"layer": "e2e"` require Playwright
end-to-end coverage against a staging environment. This is a separate,
larger workstream — see the repo root's `docs/TESTING_STAGING_REQUIREMENTS.md`
(staging audit + legacy-frontend-against-staging mechanism) and the revised
Phase 3/4/5 architecture note delivered alongside this Phase 2 commit — before
any `.spec.ts` file is added. Do not add a Playwright config pointed at
production; per `docs/STAGING.md`, production must never be a destructive
test target.

## Adding a new static check

1. Add the smallest structural extraction needed (prefer reusing
   `extractFunctionBody` / `extractTableStatements` / `extractInsertArg` over
   a new one-off regex against the whole file).
2. Assert on the extracted text, not the whole file, wherever the check is
   about one specific function or DB call.
3. Add the corresponding `inventory.json` entry (or update an existing one's
   `"layer"` to `"static"` if E2E coverage becomes redundant with it).
4. Keep the check's `detail` output specific enough that a CI failure log
   tells you what to go read, not just pass/fail.
