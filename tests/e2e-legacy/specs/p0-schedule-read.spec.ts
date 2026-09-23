import { test, expect } from '@playwright/test';
import { attachErrorCollectors, assertNoUnexpectedErrors, type AllowedRequestFailure } from '../helpers/error-collectors';
import { attachRequestStormDetector } from '../helpers/request-storm-detector';
import { login, logout, requireTeacherCredentials } from '../helpers/auth';

// sched-01 -- "schedule reads/loads" (teacher only). Strictly read-only:
// no schedule event is created, updated, or deleted by this spec.
//
// 2026-09-23 scope note: sched-01 was originally requested for both
// teacher and student. Source-traced against the live production
// index.html before writing anything here, and the student half is not
// currently reachable through any real UI control:
//   - NAV.student (the sidebar definition) has no schedule entry --
//     its ids are s_home/s_classes/s_lessons/s_homework/s_vocab/
//     s_materials only.
//   - showScreen()'s own render-dispatch table only maps
//     t_schedule/a_schedule/o_schedule to renderSchedule() -- there is
//     no s_schedule key.
//   - showScreen()'s access-control check (_allowedIds from NAV[S.role]
//     plus a small _extraAllowed map, where student only additionally
//     allows 's_vocab') would explicitly deny a student-role call to
//     open t_schedule (console.warn('[showScreen] Access denied', ...),
//     not an error, and returns before rendering anything).
//   renderSchedule() itself does contain latent query logic branching on
//   S.role==='student' (queries the student's enrolled class_ids via
//   class_students, then filters schedule_events by those class ids),
//   but that code is unreachable through the sidebar/nav today -- it is
//   dead code from a real user's perspective, not a route this spec can
//   exercise via "navigate through the real sidebar/nav control" as
//   required.
//
//   Per explicit direction: this slice is scoped to teacher only. The
//   student half is deliberately left DEFERRED / UNCOVERED, not treated
//   as "not applicable" -- it is a real, separate product/navigation gap
//   (no student-facing schedule NAV entry, no reachable UI path) that
//   this spec records but does not attempt to route around. In keeping
//   with that: this spec does not call showScreen('...') directly for
//   the student role, does not invoke renderSchedule() or any other
//   render function from test JS, and does not add any synthetic
//   test-only navigation path. It also does not modify index.html or
//   NAV. Closing that gap, if ever done, is a product/navigation change
//   for a separate task -- not something to work around here.
//
// Source-traced teacher flow (fetched and inspected 2026-09-23, commit
// main HEAD):
//   - NAV.teacher includes {id:'t_schedule', icon:'📅', l:'Расписание'},
//     rendered as a #nav_t_schedule sidebar item (buildSidebar() derives
//     #nav_<id> from NAV ids, already relied on by #nav_t_classes/
//     #nav_s_home in p0-session-reload.spec.ts).
//   - Clicking it calls showScreen('t_schedule'), which is in
//     NAV.teacher's allowed-id list, so it passes access control, sets
//     S.screen, toggles #nav_t_schedule to .active, and dispatches to
//     renderSchedule() via the fn map (t_schedule:renderSchedule).
//   - renderSchedule() calls showSkel() synchronously first (writes the
//     shared SKEL skeleton-loader markup into #content), then awaits
//     Promise.all of two fully-awaited, deduped/cached fetches (via the
//     dc() helper -- an in-flight-locked, 30s-TTL cache, not a stray
//     unawaited background call):
//       1. schedule_events: .select('*,class:class_id(name,color)')
//          .eq('school_id',S.schoolId), then for role==='teacher'
//          additionally .eq('teacher_id',S.profile.id).
//       2. classes: .select('id,name,color').eq('school_id',S.schoolId)
//          (cache key 'classes_light_'+schoolId -- already exercised
//          successfully by renderClasses() in p0-teacher-student.spec.ts,
//          so this half is already proven against staging).
//     Both are awaited before setContent() replaces the skeleton with
//     the real grid, so "loading state finishes" is structurally
//     equivalent to ".schedule-grid becomes visible" -- there is no
//     separate loading-flag to assert on.
//   - No RPC calls. No realtime subscription specific to schedule.
//   - Empty-state behavior: renderSchedule() builds a fixed 7-day x
//     16-hour (.schedule-grid) week grid unconditionally -- with zero
//     schedule_events rows, every .sch-cell is simply empty (no
//     .sch-event children) and no distinct "no events" placeholder is
//     shown. The grid itself IS the loaded state, for any row count from
//     zero upward -- so this spec deliberately does not require or
//     depend on any pre-existing schedule_events fixture row, matching
//     the "prove it loads, don't seed fake content" instruction.
//   - Race check: unlike auth-04's page.reload(), navigating to schedule
//     here is a same-page SPA transition (a sidebar click, not a browser
//     navigation), so there is no reload()-style cancellation risk for
//     whatever the previous screen (t_classes, the post-login landing
//     screen) had in flight. showScreen() sets S.screen=id synchronously
//     before dispatch, and the render functions themselves guard against
//     stale results (e.g. "if(S.screen!==_snapshotTakenBeforeAwait)
//     return;", the same pattern already documented for
//     renderStudentHome() in p0-session-reload.spec.ts) -- a late-
//     resolving previous-screen fetch is silently discarded, not
//     network-aborted, so it cannot produce a spurious ERR_ABORTED the
//     way page.reload() did in auth-04. No extra settle wait is added
//     here for that reason.
//
// Dependency classification against current staging provisioning:
//   - classes (+ RLS for teacher SELECT within their own school): already
//     proven working against staging by p0-teacher-student.spec.ts's
//     green run (renderClasses() uses the same table).
//   - schedule_events (+ RLS for teacher SELECT scoped to their own
//     teacher_id/school_id): NOT yet exercised by any existing green E2E
//     spec against staging. Static source inspection alone cannot
//     confirm the staging Supabase project (ref lqyetodkoxodwjyqxukq,
//     separate from production) has this table/policy provisioned
//     identically to production -- this spec's own zero-tolerance
//     collectors are the mechanism for finding out: a missing table,
//     missing/misconfigured RLS, or any other schedule_events access
//     problem will surface as a captured bad response / request failure
//     and fail this spec loudly (never silently skipped), which is the
//     intended "stop and report" signal for that gap if it exists. No
//     staging DB or index.html change is made speculatively ahead of
//     that evidence.
//
// Zero-tolerance, same as the other P0 specs: attachErrorCollectors and
// attachRequestStormDetector are both attached, no smoke-spec allow-list
// is used, and the one existing evidence-gated Chromium logout-204
// exception (ALLOWED_LOGOUT_ABORT, duplicated here rather than imported,
// same as the other specs) is applied only around the final logout()
// step. No schedule event is created, updated, or deleted -- this spec
// only opens the screen and reads what renderSchedule() itself fetches.

const teacherCreds = requireTeacherCredentials();

const ALLOWED_LOGOUT_ABORT: AllowedRequestFailure = {
  method: 'POST',
  url: 'https://lqyetodkoxodwjyqxukq.supabase.co/auth/v1/logout?scope=global',
  failure: 'net::ERR_ABORTED',
  requireRespondedStatus: 204,
};

test.describe('legacy app P0 -- schedule read-only load (sched-01, teacher, Chromium + WebKit)', () => {
  test('teacher: login, open schedule via sidebar, grid loads, logout', async ({ page }) => {
    const errors = attachErrorCollectors(page);
    const storm = attachRequestStormDetector(page);

    try {
      await login(page, teacherCreds);
      await expect(page.locator('#app')).toBeVisible();

      // Navigate through the real sidebar control, not a direct
      // showScreen() call -- #nav_t_schedule is buildSidebar()'s
      // rendering of NAV.teacher's {id:'t_schedule', ...} entry.
      await page.locator('#nav_t_schedule').click();
      await expect(page.locator('#nav_t_schedule')).toHaveClass(/active/);

      // showSkel() -> awaited Promise.all(schedule_events, classes) ->
      // setContent(grid). Waiting for the grid to become visible is
      // waiting for that entire load (including the loading state) to
      // finish -- there is no separate loading flag to assert on.
      await expect(page.locator('.schedule-grid')).toBeVisible();

      // No auth/session regression from navigating screens.
      await expect(page.locator('#loginForm')).not.toBeVisible();

      await logout(page);
      await expect(page.locator('#loginForm')).toBeVisible();

      storm.assertNoStorm();
      assertNoUnexpectedErrors(errors, { allowRequestFailures: [ALLOWED_LOGOUT_ABORT] });
    } catch (e) {
      console.error(
        '[sched-01 diagnostic] teacher test failed. Captured errors at failure time:\n' + JSON.stringify(errors, null, 2),
      );
      throw e;
    }
  });
});

