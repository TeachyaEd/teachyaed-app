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

`exportICal` — not yet inspected in this pass (not in the snippet
capture above); must be read before implementation, not skipped.

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
| `owner` | All school events | Yes | Any event in school | Any event in school |
| `admin` | All school events | Yes | Any event in school (cannot reassign `teacher_id` via UI) | Any event in school |
| `teacher` | Own events only | Yes (as self) | Own events only | Own events only |
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
| 7 | Create event as admin/owner | Row created with chosen/any `teacher_id` |
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
