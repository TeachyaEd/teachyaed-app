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
