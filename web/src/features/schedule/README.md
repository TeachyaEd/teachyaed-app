# Schedule feature

Implemented in PHASE 3A. Full spec, before/after RLS evidence, and the
test matrix this implementation is measured against live in
`docs/SCHEDULE_MIGRATION.md` — read that first before changing
anything here, especially anything touching authorization or the
`exportICal` field mapping.

Status: **IMPLEMENTED / AWAITING STAGING**. This slice is not wired
to production traffic — see `docs/SIDE_BY_SIDE.md`. Legacy
`index.html` remains the authoritative production Schedule
implementation until a staging environment exists and a real
multi-user runtime verification pass has been run (see
`docs/STAGING.md`).

## Layout (domain-service convention)

```
api/
  validation.ts     — pure normalize/validate helpers (no Supabase import)
  ical.ts            — pure .ics builder + browser download wrapper
  scheduleService.ts — all Supabase calls for this feature
hooks/
  useSchedule.ts     — loads events/classes for the signed-in profile,
                        exposes create/update/delete/export + loading/
                        error/empty state, stale-request-safe
components/
  SchedulePage.tsx      — page container, role-aware
  ScheduleEventForm.tsx — create/edit form
  ScheduleEventList.tsx — read-only table
types.ts             — this feature's local types (not the global
                        placeholder Database type — see
                        src/types/database.ts)
```

Rule (unchanged from before implementation): a component never calls
Supabase directly. Anything beyond a trivial read goes in `api/`.

## Authorization

Every role-based query filter in `scheduleService.ts` is a UX/parity
convenience mirroring legacy's own client-side query shape — **not**
the security boundary. The actual boundary is the 8 explicit
`schedule_*` RLS policies described in `docs/SCHEDULE_MIGRATION.md`
("HOTFIX: Schedule Authorization Correction") and
`SECURITY_BASELINE.md` §30. Do not add a client-side check here and
assume it replaces or weakens that requirement in either direction.
