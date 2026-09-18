# TeachyaED — Schedule feature: migration preparation (no implementation yet)

Re-inspected directly against the legacy source at commit
`86651cfe322900d695a00c78384db0cb1c7b7895` (fresh fetch via GitHub
Contents API, same discipline as `docs/MIGRATION_INVENTORY.md`) —
not carried over from memory. This is preparation only. No React
Schedule code exists yet (`web/src/features/schedule/` currently holds
only the convention `README.md`). Implementation is the next step
after this PHASE 2 foundation is reviewed.

## CURRENT LEGACY BEHAVIOR

`renderSchedule()`:
- Guards: if `S.role === 'student'` and the caller has no
  `S.studentRowId`, shows an empty state and returns — students
  without a linked student row see nothing rather than an error.
- Fetches `schedule_events` (`select('*, class:class_id(name,color)')`)
  filtered by `school_id`, additionally filtered:
  - `teacher` → `eq('teacher_id', S.profile.id)` (own events only)
  - `student` → resolved via the student's `class_students` rows to a
    list of enrolled `class_id`s, then `in('class_id', ids)`; if no
    enrolled classes, forces an empty result (`eq('class_id', '__no_class__')`)
  - `admin`/`owner` → no additional filter (school-wide view)
- Also fetches a light `classes` list (`id, name, color`) for the
  class-color dropdown/legend, cached per school.
- Uses a request-generation guard (`S.screen !== _schedSnap`) to
  discard a stale response if the user navigated away before the
  fetch resolved.

`openAddEventOnDate(date, time)`:
- Resets the add/edit modal form (`S.editEventId = null`, clears
  title/notes, resets status to `scheduled`, resets class dropdown to
  its first option), defaults date to "today" and time to `09:00` if
  not provided, opens the modal.

`saveEvent()`:
- Client-side role gate: only `teacher`, `admin`, `owner` may submit
  (`student` never reaches this code path in the UI, and is blocked
  again here defensively).
- Validates title, date, time are non-empty client-side before
  sending.
- Builds a payload: `school_id`, `class_id` (nullable), `teacher_id`
  (`S.profile.id` — always the *caller's own* id, never
  client-chosen for a different teacher), `title`, `event_date`,
  `event_time` (truncated to `HH:MM`), `duration_minutes` (parsed
  int, falls back to 60 if invalid/≤0), `status` (must be one of
  `scheduled`/`completed`/`cancelled`, else falls back to
  `scheduled`), `notes`.
- Update path (`S.editEventId` set): if role is `admin`/`owner`,
  `teacher_id` is stripped from the update payload (so an admin
  editing someone else's event doesn't reassign it); the update query
  is additionally scoped `.eq('teacher_id', S.profile?.id)` for a
  plain `teacher` (so a teacher can only update their own events —
  enforced client-side here, and this must be independently true via
  RLS, not assumed).
- Insert path: creates a new row (not shown in the captured snippet
  tail, but follows the same `data` payload).

`deleteEvent(id)`:
- Same client-side role gate as `saveEvent`.
- Confirms with the user first.
- Deletes scoped to `school_id`, additionally `.eq('teacher_id', S.profile?.id)`
  for a plain `teacher`.
- Checks the returned deleted row count (`.select('id')` after
  delete) — if zero rows came back, shows "no permission" rather than
  silently succeeding. This is a client-side signal, not proof of the
  RLS boundary; the real boundary must be verified against the actual
  `schedule_events` RLS policies before React re-implements this
  check, not assumed identical from this snippet alone.

`exportICal` — now fully inspected; see the dedicated section below.

## TARGET REACT BEHAVIOR

Same behavior, same authorization boundary, same payload shape,
ported into `web/src/features/schedule/{api,hooks,components}` per
the domain-service convention in `web/src/features/schedule/README.md`.
No new business rule, no relaxed or tightened role gate, no new
client-side "authorization" beyond what legacy already does for UX
(the legacy client-side role checks above are UX/early-exit
conveniences, not the security boundary — RLS is, unchanged).

## TABLES

`schedule_events` (columns observed in use, not a full schema dump —
still no `supabase gen types typescript` run, see
`web/src/types/database.ts`): `id`, `school_id`, `class_id`
(nullable, FK to `classes`), `teacher_id`, `title`, `event_date`,
`event_time`, `duration_minutes`, `status`
(`scheduled`/`completed`/`cancelled`), `notes`.

Joined read-only: `classes` (`id`, `name`, `color`) for display, and
`class_students` (read-only, to resolve a student's enrolled classes).

## RLS

Not re-verified against live policy text in this pass (that would
require a SQL Editor query, which is out of scope for a docs-prep
step and was not run). The legacy client-side scoping above
(`teacher_id` filters, `school_id` filters) is a strong signal of
intended RLS shape, consistent with prior audits' general pattern for
this app (tenant isolation by `school_id`, row ownership by actor id)
— but before React implementation ships, the actual
`schedule_events` RLS policies should be re-read directly, per
`SECURITY_BASELINE.md`'s "never assume, verify" discipline, the same
way every other table in this engagement was verified before being
trusted.

## ROLE BEHAVIOR

| Role | Read | Create | Update | Delete |
|---|---|---|---|---|
| `admin` | All school events | Yes (always as self — no teacher picker exists) | Any event in school (cannot reassign `teacher_id` via UI) | Any event in school |
| `teacher` | Own events only | Yes (as self) | Own events only | Own events only |
| `owner` | All school events | Yes (always as self — no teacher picker exists) | Any event in school (cannot reassign `teacher_id` via UI) | Any event in school |
| `student` | Own enrolled classes' events (or none, if no enrolled classes / no student row) | No | No | No |

## CRUD OPERATIONS

Create (insert), Read (list, filtered), Update (edit existing), Delete
— all four exist in legacy and must exist in the React port. No new
operation (e.g. bulk delete, recurring events) is in scope for this
slice — that would be a new business rule, out of bounds per PART 25
of the migration instructions.

## VALIDATION

- Title: required, non-empty (trimmed).
- Date: required.
- Time: required; stored truncated to `HH:MM`.
- Duration: parsed as integer; falls back to 60 if missing/invalid/≤0
  — React should preserve this fallback rather than hard-erroring, to
  match legacy behavior exactly.
- Status: must be one of `scheduled`/`completed`/`cancelled`; falls
  back to `scheduled` otherwise.

## ERROR STATES

- Save/delete Supabase error → toast with the raw `error.message` in
  legacy. React should route this through `toAppError()`
  (`web/src/lib/errors.ts`) instead of showing a raw Postgres error
  string, which is a deliberate, documented improvement (allowed per
  PART 25 — "clear validation feedback" — not a business-rule change),
  not a silent behavior change to the authorization outcome itself.
- Delete returning zero affected rows → "no permission" message in
  legacy (client-side inference from row count, not a real
  server-side permission check result) — React should preserve
  showing a forbidden-style message in this case, sourced through the
  same `AppError('forbidden', …)` path used elsewhere.

## EMPTY STATES

- Student with no `studentRowId` → empty state, "Профиль ученика не
  найден" (student profile not found).
- Student with no enrolled classes → empty event list (forced by the
  `__no_class__` filter trick) — React should show a proper "no
  classes yet" empty state rather than reproducing the sentinel-value
  trick, which is an internal implementation detail, not a behavior
  the user should be able to observe either way.

## TEST MATRIX (drafted; not run — see web/tests/e2e/README.md)

| # | Scenario | Expected |
|---|---|---|
| 1 | Load schedule as teacher | Only own events returned |
| 2 | Load schedule as admin/owner | All school events returned |
| 3 | Load schedule as student, enrolled in ≥1 class | Only enrolled classes' events returned |
| 4 | Load schedule as student, no student row | Empty state, no query error |
| 5 | Load schedule as student, no enrolled classes | Empty list, no error |
| 6 | Create event as teacher | Row created with `teacher_id = self`; visible to self, admin, owner |
| 7 | Create event as admin/owner | Row created with `teacher_id = self` (no teacher-picker UI exists — corrected, see "Correction to the previous pass" below) |
| 8 | Edit own event as teacher | Succeeds |
| 9 | Edit another teacher's event as teacher | Fails (backend-enforced; UI shouldn't offer it, but the test asserts the backend denies it even if attempted directly) |
| 10 | Edit any event as admin/owner | Succeeds, `teacher_id` unchanged by the edit |
| 11 | Delete own event as teacher | Succeeds |
| 12 | Delete another teacher's event as teacher | Fails (backend-enforced) |
| 13 | Backend failure (network/5xx) on save | Safe error message shown, no raw error text, no crash |
| 14 | Session loss mid-edit | Redirect to login via existing `RequireAuth`/auth-error handling, no silent data loss without a message |
| 15 | Role-specific UI | Student never sees create/edit/delete controls; teacher sees them scoped to own events; admin/owner see them unscoped |

Per the migration instructions: rows 9 and 12 (negative authorization)
are backend/RLS-driven and must be proven against the real backend
(staging, once it exists) — a mocked-UI test passing is not evidence
of RLS working, and will not be reported as such.

## `exportICal` (previously NOT inspected — now fully inspected)

PHASE 2.1's Schedule preparation doc explicitly flagged this as unread.
It has now been read directly from the legacy source (`exportICal`,
async function, plus its `_icalEsc` escaping helper). Exact behavior:

**Scope of exported events** — mirrors `renderSchedule`'s read scoping
exactly:
- `teacher` → `eq('teacher_id', S.profile.id)` (own events only).
- `student` → resolved via `class_students` to enrolled `class_id`s,
  then `in('class_id', ids)`; if the student has no enrolled classes,
  legacy forces an empty result via the `__no_class__` sentinel filter
  (React should return an empty result directly instead, per PART 9 of
  the Schedule implementation instructions — same as the read-scope
  fix already noted below for `renderSchedule`). If the student has no
  `studentRowId` at all, legacy shows a session-expired banner and an
  error toast and aborts the export entirely (does not silently
  produce an empty calendar).
- `admin`/`owner` → no additional filter (school-wide export).
- **No status filtering** — `scheduled`, `completed`, and
  `cancelled` events are all included in the export. Cancelled events
  are exported with `STATUS:CANCELLED`; every other status (including
  `completed`) is exported with `STATUS:CONFIRMED`. There is no
  `STATUS:TENTATIVE` or other mapping.

**Per-event field mapping:**
- Events with a falsy `event_date` are skipped entirely (not
  exported, no error).
- `event_time` defaults to `'09:00'` if missing, then is truncated
  to its first 5 characters (`HH:MM`).
- The start `Date` is constructed as `new Date(event_date + 'T' +
  time + ':00')` (i.e. `YYYY-MM-DDTHH:MM:00`, parsed as a *local*
  time string by the JS `Date` constructor — no explicit `Z` suffix,
  no explicit offset). If this produces an invalid `Date`
  (`isNaN(getTime())`), the event is skipped entirely (not exported,
  no error).
- End time = start time + `duration_minutes` (parsed as int, falls
  back to 60 if not parseable — same fallback as `saveEvent`)
  minutes, computed in milliseconds.
- `DTSTART`/`DTEND` are written as **floating local time**: formatted
  as `YYYYMMDDTHHMMSS` with **no trailing `Z` and no `TZID`
  parameter**. This means the exported `.ics` file does not carry any
  timezone information at all — a calendar app importing it will
  interpret the date/time in *its own* local timezone, whatever that
  happens to be, not the school's actual timezone. This is an existing
  ambiguity in legacy, not something to "fix" during migration — it
  must be preserved exactly (per PART 14's "document the ambiguity
  rather than guessing").
- `UID`: `${event.id}@${schoolId || 'school'}.teachyaed` — no escaping
  applied (UUIDs and school IDs are not expected to contain
  iCalendar-special characters).
- `SUMMARY`: `title`, escaped via `_icalEsc`.
- `DESCRIPTION`: `notes || ''`, escaped via `_icalEsc`.
- `_icalEsc(s)` applies RFC 5545 TEXT escaping in this exact order:
  backslash → `\\\\`, then semicolon → `\\;`, then comma → `\\,`,
  then newline → literal `\\n`. React's iCal generator must replicate
  this exact order (backslash first, to avoid double-escaping the
  backslashes introduced by the later replacements).

**File structure:**
- `BEGIN:VCALENDAR`, `VERSION:2.0`, `CALSCALE:GREGORIAN`,
  `PRODID:-//TeachyaED//TeachyaED//EN`, `X-WR-CALNAME:TeachyaED`
  (escaped, though the literal string has nothing to escape),
  `METHOD:PUBLISH`, then one `BEGIN:VEVENT`/`END:VEVENT` block per
  included event, then `END:VCALENDAR`.
- Lines joined with `\r\n` (CRLF, per RFC 5545), trailing `\r\n` at
  end of file.
- MIME type: `text/calendar;charset=utf-8`.
- Filename: fixed `teachyaed-schedule.ics` — **not localized**, same
  for every language/role.
- Delivered via a client-side `Blob` + object URL + synthetic
  `<a download>` click (a browser-only download mechanism). React's
  equivalent should produce the same file bytes; the exact delivery
  mechanism (Blob download vs. other) is an implementation detail as
  long as the resulting `.ics` content is byte-for-byte equivalent
  for the same input events.

## Correction to the previous pass

The original version of this document's test matrix (row 7) stated:
"Create event as admin/owner → Row created with chosen/any
`teacher_id`." **This was wrong** and is corrected now that
`saveEvent`'s insert path has been read in full: the insert payload
*always* sets `teacher_id: S.profile.id` — the id of whoever is
submitting the form — regardless of role. There is no teacher-picker
field anywhere in the add/edit event form (confirmed: no `ev_teacher`
element exists in `index.html`). So an admin or owner creating a new
event also becomes that event's `teacher_id`, exactly like a teacher
creating their own event. Only the *update* path treats admin/owner
differently (by stripping `teacher_id` from the update payload so an
edit doesn't reassign ownership). The role behavior table and CRUD
section below are corrected to reflect this.

Corrected row 7: **Create event as admin/owner → Row created with
`teacher_id = self` (the admin/owner's own id), same as a teacher
creating their own event. There is no UI path to create an event
"for" a different teacher.**

## LIVE RLS VERIFICATION (read directly from `pg_policies` on the production project, 2026-09-18)

This section records the ACTUAL policies currently enforced on
`schedule_events`, `classes`, and `class_students`, read live via
`select policyname, cmd, roles, qual, with_check from pg_policies
where schemaname='public' and tablename in (...)`. This is
verification only — no policy was modified to produce this section.

### `schedule_events` (2 policies total)

**`se_staff_write`** — `FOR ALL`, role `public`:
```
USING:      (school_id = get_my_school_id())
            AND (get_my_role() = ANY (ARRAY['teacher','admin','owner']))
WITH CHECK: (school_id = get_my_school_id())
            AND (get_my_role() = ANY (ARRAY['teacher','admin','owner']))
            AND (teacher_id IS NULL OR teacher_id IN (
                  SELECT profiles.id FROM profiles
                  WHERE profiles.school_id = get_my_school_id()))
            AND (class_id IS NULL OR class_id IN (
                  SELECT classes.id FROM classes
                  WHERE classes.school_id = get_my_school_id()))
```

**`se_select`** — `FOR SELECT`, role `public`:
```
USING: (school_id = get_my_school_id())
```

### `classes` (4 policies) and `class_students` (4 policies)

Both follow the same shape: `_select` policies scope to `school_id =
get_my_school_id()` only (no role check); `_insert`/`_update`/`_delete`
require `get_my_role() IN ('admin','owner','teacher')` plus school_id
match, and (for classes) a check that `teacher_id`, if set, belongs to
*some* profile in the same school.

## ⚠️ MATERIAL MISMATCH WITH THE DOCUMENTED INTENDED AUTHORIZATION MODEL

Per the Schedule migration instructions, the intended model is:

```
owner/admin : school-wide read/create/update/delete
teacher     : own events only for relevant writes; own intended read scope
student     : read-only, scoped to enrolled classes; no create/update/delete
```

**Actual live enforcement is materially different in two ways:**

1. **`se_select` has NO role check and NO class-enrollment scoping.**
   It only checks `school_id = get_my_school_id()`. This means ANY
   authenticated user with a profile in the school — including a
   `student` role — can `SELECT` **every** schedule_events row for
   the whole school, not just events for classes they're enrolled in,
   and a `teacher` can read every other teacher's events too. The
   legacy app's own query-time filtering (role-scoped queries in
   `renderSchedule`/`exportICal`) is currently the *only* thing
   narrowing what a teacher or student actually sees — it is
   client-side convenience filtering, not enforced authorization. Any
   client (including a hand-crafted request bypassing the legacy UI)
   can already read the full school schedule today, regardless of
   role.

2. **`se_staff_write`'s `teacher_id` check is not "own events only."**
   The `WITH CHECK`/`USING` clause verifies `teacher_id IS NULL OR
   teacher_id IN (SELECT profiles.id FROM profiles WHERE
   profiles.school_id = get_my_school_id())` — i.e. it only confirms
   the `teacher_id` belongs to *some* staff member of the same
   school, not that it equals `auth.uid()`/the caller's own id. A
   `teacher`-role caller can currently `UPDATE`/`DELETE`/re-insert
   **any** other teacher's schedule_events row, not just their own.
   "Own events only" for teachers is, like point 1, enforced only by
   the legacy frontend's query construction (`eq('teacher_id',
   S.profile.id)`), not by RLS.

**This is a pre-existing condition of the live database — it was not
introduced or changed by this migration pass, and no policy was
modified to discover it.** It affects the current production legacy
app exactly as much as it would affect a literal-parity React port:
today, any authenticated school member can already read/write more of
`schedule_events` than the legacy UI's own query filters suggest,
if they call the Supabase REST/JS API directly instead of going
through `index.html`.

**Per the Schedule migration instructions' explicit stop condition
(§3): SCHEDULE MIGRATION MUTATIONS ARE PAUSED pending a decision from
the project owner on how to proceed.** Implementing the React
service layer's create/update/delete against the *documented*
per-teacher/per-student model would give a false sense of enforced
security — the UI would hide the teacher-picker and restrict which
rows it shows, but the database would still accept a role-appropriate
write against any other teacher's row, and would still return every
event to every reader, exactly as it does for legacy today.

No production changes have been made as a result of this finding.


---

## HOTFIX: Schedule Authorization Correction (2026-09-18)

**Status: CLOSED.** The gap documented above under "LIVE RLS VERIFICATION" /
"MATERIAL MISMATCH WITH THE DOCUMENTED INTENDED AUTHORIZATION MODEL" has been
root-caused and fixed at the database layer. This section records the BEFORE
state, the root cause, the intended authorization model, the fix as applied,
the AFTER state, the evidence level behind each claim, and the one remaining
gap. The original finding above is preserved unmodified — it is the
discovery record; this section is the remediation record.

### BEFORE (live production policies prior to this hotfix)

Two broad permissive policies existed on `public.schedule_events`:

```sql
-- se_select (FOR SELECT)
USING (school_id = get_my_school_id())
-- No role check. No class-enrollment scoping. Any authenticated member of
-- the school — student, teacher, admin, owner — could read every row.

-- se_staff_write (FOR ALL)
-- Restricted to role IN ('teacher','admin','owner') and same school_id,
-- but its teacher_id check verified the id belonged to *some* profile in
-- the school, not that it equalled auth.uid(). Any teacher could
-- therefore INSERT/UPDATE/DELETE any other teacher's rows.
```

(Exact clause text as captured pre-fix is in the "LIVE RLS VERIFICATION"
section above.)

### Root cause

RLS on `schedule_events` was written to enforce **tenant isolation**
(same-school) but never enforced **horizontal, per-user isolation** within a
tenant (per-teacher ownership, per-student class enrollment). The legacy
frontend's own query filters (`eq('teacher_id', S.profile.id)`,
enrollment-scoped queries for students) created the *appearance* of
per-user scoping, but nothing prevented a direct Supabase REST/JS API call
from bypassing those frontend filters. This is a pre-existing condition,
not something introduced by the React migration — the migration's live-RLS
re-verification pass is what surfaced it.

### Intended authorization model (verified against fresh legacy `index.html` source)

- `owner` / `admin`: school-wide read; may create/update/delete any
  `schedule_events` row in their own school.
- `teacher`: may read/update/delete only events where
  `teacher_id = auth.uid()`. May create events, always as self
  (`teacher_id = auth.uid()`) — legacy has no teacher-picker UI for any
  role, including admin/owner.
- `student`: read-only, and only for events whose `class_id` is a class
  the student is actually enrolled in via `class_students` (resolved
  through the same email-matched `students`↔`profiles` linkage already
  proven correct on `homeworks`/`lesson_assignments`, since `students` has
  no direct FK to `auth.users`/`profiles`). No create/update/delete.
- Cross-school access: denied for every role, in every direction.

### Fix as applied to production

`se_select` and `se_staff_write` were **dropped and replaced** (not
layered — Postgres RLS permissive policies combine with OR, so adding a
narrower policy alongside a broad one does not narrow effective access) with
8 explicit, single-operation/single-role policies:

```sql
BEGIN;

DROP POLICY IF EXISTS se_select ON schedule_events;
DROP POLICY IF EXISTS se_staff_write ON schedule_events;

CREATE POLICY schedule_select_admin_owner ON schedule_events
  FOR SELECT
  USING (
    school_id = get_my_school_id()
    AND get_my_role() = ANY (ARRAY['admin','owner'])
  );

CREATE POLICY schedule_select_teacher ON schedule_events
  FOR SELECT
  USING (
    school_id = get_my_school_id()
    AND get_my_role() = 'teacher'
    AND teacher_id = auth.uid()
  );

CREATE POLICY schedule_select_student ON schedule_events
  FOR SELECT
  USING (
    school_id = get_my_school_id()
    AND get_my_role() = 'student'
    AND class_id IS NOT NULL
    AND class_id IN (
      SELECT cs.class_id FROM class_students cs
      WHERE cs.school_id = get_my_school_id()
        AND cs.student_id IN (
          SELECT s.id FROM students s
          WHERE lower(s.email) = lower((SELECT p.email FROM profiles p WHERE p.id = auth.uid()))
        )
    )
  );

CREATE POLICY schedule_insert_staff ON schedule_events
  FOR INSERT
  WITH CHECK (
    school_id = get_my_school_id()
    AND get_my_role() = ANY (ARRAY['teacher','admin','owner'])
    AND teacher_id = auth.uid()
    AND (class_id IS NULL OR class_id IN (SELECT c.id FROM classes c WHERE c.school_id = get_my_school_id()))
  );

CREATE POLICY schedule_update_teacher ON schedule_events
  FOR UPDATE
  USING (
    school_id = get_my_school_id()
    AND get_my_role() = 'teacher'
    AND teacher_id = auth.uid()
  )
  WITH CHECK (
    school_id = get_my_school_id()
    AND get_my_role() = 'teacher'
    AND teacher_id = auth.uid()
    AND (class_id IS NULL OR class_id IN (SELECT c.id FROM classes c WHERE c.school_id = get_my_school_id()))
  );

CREATE POLICY schedule_update_admin_owner ON schedule_events
  FOR UPDATE
  USING (
    school_id = get_my_school_id()
    AND get_my_role() = ANY (ARRAY['admin','owner'])
  )
  WITH CHECK (
    school_id = get_my_school_id()
    AND get_my_role() = ANY (ARRAY['admin','owner'])
    AND (teacher_id IS NULL OR teacher_id IN (SELECT p.id FROM profiles p WHERE p.school_id = get_my_school_id()))
    AND (class_id IS NULL OR class_id IN (SELECT c.id FROM classes c WHERE c.school_id = get_my_school_id()))
  );

CREATE POLICY schedule_delete_teacher ON schedule_events
  FOR DELETE
  USING (
    school_id = get_my_school_id()
    AND get_my_role() = 'teacher'
    AND teacher_id = auth.uid()
  );

CREATE POLICY schedule_delete_admin_owner ON schedule_events
  FOR DELETE
  USING (
    school_id = get_my_school_id()
    AND get_my_role() = ANY (ARRAY['admin','owner'])
  );

COMMIT;
```

Applied during a low-risk deployment window as catalog-metadata-only DDL
(`CREATE`/`DROP POLICY` does not rewrite table data and does not touch
`lessons`/calls/realtime tables). Dry-run validated inside
`BEGIN...ROLLBACK` before the real `COMMIT`.

Key structural point: `schedule_update_teacher`'s `WITH CHECK` re-asserts
`teacher_id = auth.uid()` on the **new** row, which closes the
ownership-rebinding vector structurally — a teacher cannot change
`teacher_id`/`school_id` on their own row to escape or reassign ownership,
regardless of what the frontend does or doesn't submit.

### AFTER (live production policies, fresh-read post-`COMMIT`)

A fresh `SELECT policyname, cmd, permissive, roles, qual, with_check FROM
pg_policies WHERE schemaname='public' AND tablename='schedule_events'`,
run in a separate SQL Editor session after commit, confirmed all 8 policies
above are live, `PERMISSIVE`, role `{public}`, with `qual`/`with_check`
text matching the submitted SQL exactly — no discrepancy between submitted
and live text.

### Evidence level

- **Structural (catalog-level):** `security/security_baseline.sql` §10
  checks RLS-enabled, all 8 expected policy names present, both old broad
  policy names absent, exact policy count = 8. Live result: 80/80 checks
  PASS (68 pre-existing baseline checks + 12 new schedule_events checks).
- **Behavioral (SQL-context, rollback-only):** a 21-scenario negative
  authorization matrix run directly against production inside
  `BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claims = ...;
  ... ROLLBACK;`, impersonating 5 real production identities (2 teachers,
  admin, owner, 1 student) across synthetic classes/enrollments/events
  created and rolled back in the same transaction. Result: **21/21 PASS**,
  covering enrolled/non-enrolled/no-class student reads and all writes,
  teacher-vs-teacher horizontal read/update/delete/insert/rebind attempts,
  and admin/owner school-wide access. A post-hoc `SELECT count(*) FROM
  schedule_events WHERE title LIKE 'RLS_TEST%'` confirmed **0** — zero
  durable rows were left behind.
  - Cross-school denial specifically is **CODE ANALYSIS PROTECTED**, not
    empirically exercised: every one of the 8 policies includes
    `school_id = get_my_school_id()`, but this production database
    currently contains only one school, so there was no second school's
    data to attempt cross-school access against.
- **Runtime multi-user E2E (real HTTP requests from two distinct logged-in
  sessions, e.g. via a staging environment): NOT RUN.** No staging
  environment exists (see `docs/STAGING.md`). This remains a required step
  before any production React cutover that touches Schedule.

### Legacy compatibility

All flows the legacy frontend already performs remain permitted by
construction, because each new policy's `USING`/`WITH CHECK` is a superset
of what the legacy UI's own query filters already restrict to: admin/owner
school-wide read, teacher own read/create/edit/delete, student
enrolled-class read, and `exportICal` for each role (which only ever reads
rows the caller's SELECT policy already permits, and adds no new query
shape).

### Remaining gap

Runtime multi-user staging E2E verification is **NOT RUN** — tracked as a
prerequisite for the eventual React Schedule cutover, not for closing this
hotfix (which is a database-authorization correction, independent of any
frontend).
