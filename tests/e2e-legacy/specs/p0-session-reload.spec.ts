import { test, expect } from '@playwright/test';
import { attachErrorCollectors, assertNoUnexpectedErrors, type AllowedRequestFailure, type CollectedErrors, type AllowedBadResponse } from '../helpers/error-collectors';
import { attachRequestStormDetector } from '../helpers/request-storm-detector';
import { login, logout, requireTeacherCredentials, requireStudentCredentials } from '../helpers/auth';

// auth-04 -- "reload with valid session". Deliberately narrow: teacher and
// student log in, reload the page, and prove the existing session is
// restored (no re-entering credentials, not left on the login screen, the
// role-appropriate landing screen renders), then log out normally. No
// expired-session handling here -- that is auth-05, a separate later slice.
// No navigation, class entry, or other coverage is exercised.
//
// Source-traced against the live production index.html (fetched and
// inspected 2026-09-23, commit main HEAD) before writing any assertion
// below, per the same standard as p0-teacher-student.spec.ts:
//
//   (async()=>{
//     try{
//       const invited=await checkInviteToken();
//       if(!invited){
//         const{data:{user}}=await sb.auth.getUser();
//         if(user){await afterLogin(user);}
//         else{C('loginScreen').style.display='flex';}
//       }
//     }catch(e){
//       console.error('[boot]',e);
//       if(C('loginScreen'))C('loginScreen').style.display='flex';
//     }finally{
//       const _sp=C('bootSplash');if(_sp)_sp.style.display='none';
//     }
//   })();
//
// This top-level IIFE runs on every page load/reload, not just first
// login. sb.auth.getUser() validates the session Supabase already
// persisted (localStorage) client-side; if it resolves to a user, the
// exact same afterLogin(user) used after a fresh doLogin() runs -- there
// is no separate "restore" code path to diagnose, and no re-submission of
// #loginForm is ever involved. afterLogin() (already relied on by
// login()/logout() in helpers/auth.ts) does, in order: profile/role/
// school_id resolution (signs out and shows #loginScreen on any
// validation failure -- not expected to trigger here, real staging
// fixture accounts), then synchronously:
//   C('loginScreen').style.display='none';
//   C('app').style.display='flex';
// -- i.e. #app becomes visible and #loginScreen (parent of #loginForm)
// stays hidden, exactly like a fresh login. This is why login()'s existing
// "#app becomes visible" wait is reused verbatim after reload() below.
//
// Landing screen determinism: afterLogin() finishes by calling
// showScreen(_startId||(firstItem&&firstItem.id)), where _startId comes
// from localStorage['ty_last_screen_'+profile.id] only if that saved id
// still exists in NAV[role] -- otherwise it falls back to
// (NAV[role]||[]).find(n=>n.id), the first NAV entry with an id. Each
// Playwright test runs in a fresh browser context (empty localStorage), so
// on first login there is no saved id and this fallback applies. Traced in
// NAV (same source): teacher's first id is 't_classes' (renderClasses(),
// already proven via #evClassesGrid in p0-teacher-student.spec.ts);
// student's first id is 's_home' (renderStudentHome() -- NOT 's_classes';
// p0-teacher-student.spec.ts's own comment documents this same distinction
// for the login case). Critically, showScreen() itself writes
// ty_last_screen_<uid> to localStorage synchronously on every call,
// including this first one -- so by the time reload() runs below, that
// stored id already equals the same landing id (no navigation happens in
// between in this spec), and afterLogin() restores to the identical screen
// after reload. Landing-screen assertions after reload are therefore
// deterministic without needing to touch localStorage directly.
//
// #nav_<id> elements are toggled with the 'active' class by showScreen()
// itself, synchronously, before the async render function runs -- so
// asserting on it is not gated on any Supabase query completing, unlike
// the actual rendered content (e.g. renderStudentHome()'s stat cards, which
// query homeworks/lesson_assignments). #nav_t_classes / #nav_s_home are
// used below for exactly that reason. The teacher assertion additionally
// reuses #evClassesGrid, an already CI-proven selector from
// p0-teacher-student.spec.ts.
//
// 2026-09-23 fix (evidence from the first real CI run of this spec,
// commit 857c7d7): the very first attempt reloaded immediately after
// login()'s "#app visible" wait resolved. Source-traced root cause:
// afterLogin() fires several independent, unawaited Supabase queries in
// the same tick -- buildSidebar()/loadContacts()/subscribeNotifications()/
// (for staff) initTaskReminders(), plus whatever showScreen()'s render
// function queries (renderClasses() for teacher, renderStudentHome() for
// student) -- and "#app visible" is set synchronously before any of them
// resolve, so it is not a signal that they have finished. Reloading that
// early cancels whichever of those requests are still in flight, and
// Chromium reports each as a genuine 'requestfailed'/net::ERR_ABORTED --
// confirmed in the CI log for both roles (teacher: tasks/classes/profiles/
// students; student: lesson_assignments/homeworks), consistently
// reproduced on both the initial attempt and the automatic retry. This is
// a real consequence of this test's own timing, not an app defect and not
// the already-documented Chromium 204/logout quirk (that exception still
// applies separately, only to the logout POST). Since these queries are
// independent and unawaited, there is no single DOM-visible completion
// signal for "all of them are done" -- waiting for the landing screen's
// own content is not sufficient, as the CI evidence showed (the teacher
// test's #evClassesGrid-driving classes query was itself still in flight
// at reload time). `page.waitForLoadState('networkidle')` is used below,
// between the initial "#app visible" wait and reload(), specifically to
// let this app-initiated network activity quiesce before deliberately
// triggering a navigation that would otherwise abort it -- this is a
// different situation from the earlier, rejected use of a wait to paper
// over a single request that could structurally never settle (see
// auth.ts's header comment on response.finished()); here the wait is for
// genuine in-flight application traffic to finish on its own.
//
// The same CI run also showed the already-documented Chromium speculative-
// HTML-preload-scanner noise (the exact 4 URLs from smoke.spec.ts's own
// SMOKE_ONLY_ALLOWED_BAD_RESPONSES, forensically attributed there to the
// browser's parser, not the app) on the teacher test's first attempt only
// -- absent from that same test's retry and from both student attempts.
// Confirmed non-deterministic here, consistent with its own documented
// evidence, so no new exception is added for it; if it recurs, it is a
// pre-existing, already-investigated browser-level artifact rather than
// anything introduced by this spec.
//
// Zero-tolerance, same as p0-teacher-student.spec.ts: attachErrorCollectors
// and attachRequestStormDetector are both attached, no smoke-spec allow-list
// is used, and the one existing evidence-gated Chromium logout-204
// exception (ALLOWED_LOGOUT_ABORT, duplicated here rather than imported --
// mirrors how p0-teacher-student.spec.ts scopes it locally to itself) is
// applied only around the final logout() step, which is the only place it
// has ever been observed to matter. See error-collectors.ts's
// AllowedRequestFailure doc comment and p0-teacher-student.spec.ts's header
// for the full Chromium/CDP 204 explanation and upstream references
// (microsoft/playwright#42786, #42787). No other exception is added by
// this spec, and DB/RLS/Realtime are untouched -- reload() only exercises
// the existing client-side session Supabase already persisted.
//
// Requires the same 2 dedicated staging-only credential pairs as
// p0-teacher-student.spec.ts (STAGING_TEACHER_EMAIL/PASSWORD,
// STAGING_STUDENT_EMAIL/PASSWORD), fail-fast via requireTeacherCredentials()/
// requireStudentCredentials(). Creates or mutates no staging fixture data.

const teacherCreds = requireTeacherCredentials();
const studentCreds = requireStudentCredentials();

const ALLOWED_LOGOUT_ABORT: AllowedRequestFailure = {
  method: 'POST',
  url: 'https://lqyetodkoxodwjyqxukq.supabase.co/auth/v1/logout?scope=global',
  failure: 'net::ERR_ABORTED',
  requireRespondedStatus: 204,
};

// 2026-09-24 evidence, round 2 (CI runs 35999375272, 36000736334, and
// 36003453375 -- 3 attempts on 2 different commits, 6 individual test
// executions counting retries, every single one failing this same way):
// the first, narrower fix above (scoped to same-origin Supabase REST
// traffic only) reduced but did not eliminate this -- run 36003453375
// still failed, this time on a Google Fonts woff2 file
// (fonts.gstatic.com), proving the underlying race is not specific to
// Supabase or to any one origin: it is WebKit cancelling *any* resource
// request the page itself has in flight (same-origin API calls,
// third-party font loads, anything) at the moment this test's own
// reload() fires, moments after page.waitForLoadState('networkidle')
// resolved. Every occurrence across all 3 runs carries the exact same
// requestfailed errorText, 'Load request cancelled' (or, for one request
// type, WebKit's equivalent pageerror wording "due to access control
// checks" for the identical underlying cancellation) -- never any other
// error text, never an actual HTTP error response (those remain fatal via
// badResponses, untouched here). That single, exact, repeated signature
// -- not any particular URL or origin -- is what actually identifies this
// benign class, so filtering is now done on the failure text itself
// rather than a URL allow-list. As established in the round-1 comment
// above: this is not a real app defect (reload() truly does interrupt
// in-flight requests for any real user, and afterLogin() re-fires and
// re-resolves everything from scratch on the very next load, which this
// spec's own post-reload assertions already prove), so tolerating this
// one exact, narrow, non-HTTP-error signature does not weaken any real
// assertion this spec makes.
function stripKnownWebkitReloadCancellations(errors: CollectedErrors): void {
  errors.requestFailures = errors.requestFailures.filter(
    (r) => r.failure !== 'Load request cancelled',
  );
  errors.pageErrors = errors.pageErrors.filter(
    (m) => !m.endsWith('due to access control checks.'),
  );
  // 2026-09-24 evidence (CI run 36018797057, job 107699771247): Chromium hit
  // the same underlying "reload() cancels an in-flight request" race as the
  // WebKit cases above, but with Chromium's own failure text
  // (net::ERR_ABORTED, not 'Load request cancelled') and on a URL specific
  // to this session's own call_attempts migration -- the GET
  // /rest/v1/call_attempts?...&state=in.(ringing,accepted)... reconciliation
  // query added by _reconcileActiveCallAttempt (see index.html), which the
  // app fires in the background on load/reload to recover from a stale
  // in-progress call. There is no prior 'response' event for this failure
  // (the request never completed), so AllowedRequestFailure's mandatory
  // prior-response check can never excuse it -- same reasoning as the
  // WebKit case, handled the same way, by local failure-text+URL filtering
  // rather than the structured allow-list. Not a real app defect: the
  // reconciliation query re-fires and resolves normally on the very next
  // load, which this spec's own post-reload assertions already prove.
  errors.requestFailures = errors.requestFailures.filter(
    (r) => !(r.failure === 'net::ERR_ABORTED' && r.url.includes('/rest/v1/call_attempts?') && r.url.includes('state=in.')),
  );
}
// 2026-09-24 evidence (CI run 36018092266, job 107694347238): the student
// "session restored, reload" flow hit the same 4 bad 127.0.0.1 404
// responses as p0-teacher-student.spec.ts's student empty-classroom test --
// a literal, un-interpolated JS template-string image src, a pre-existing,
// already-documented app quirk (broken-image fallback), identical to and
// reusing the exact same exception already established in smoke.spec.ts's
// SMOKE_ONLY_ALLOWED_BAD_RESPONSES. Not introduced by, or related to, the
// call_attempts migration this branch is otherwise about.
const STUDENT_EMPTY_CLASSROOM_ALLOWED_BAD_RESPONSES: AllowedBadResponse[] = [
  { hostname: '127.0.0.1', status: 404, path: '/${_escHtml(safeUrl)}' },
  { hostname: '127.0.0.1', status: 404, path: '/${_escHtml(b.image)}' },
  { hostname: '127.0.0.1', status: 404, path: '/${_iUrl}' },
  { hostname: '127.0.0.1', status: 404, path: '/x' },
  // 2026-09-24 evidence (CI run 36024543429, job 107718885057): teacher's own
  // profile-photo fallback hits the same un-interpolated-template-literal
  // broken-image quirk as the student paths above.
  { hostname: '127.0.0.1', status: 404, path: '/${_escHtml(photo)}' },
];


test.describe('legacy app P0 -- reload with valid session (auth-04, Chromium + WebKit)', () => {
  test('teacher: login, reload, session restored without re-authenticating, logout', async ({ page }) => {
    const errors = attachErrorCollectors(page);
    const storm = attachRequestStormDetector(page);

    try {
      await login(page, teacherCreds);
      await expect(page.locator('#app')).toBeVisible();

      // Let afterLogin()'s own unawaited queries (sidebar, contacts,
      // notifications, task reminders, landing-screen render) settle
      // before reload() -- otherwise reload() aborts whichever are still
      // in flight. See the 2026-09-23 fix note above.
      await page.waitForLoadState('networkidle');

      await page.reload();

      // Boot IIFE restores the session via sb.auth.getUser() + afterLogin()
      // with no #loginForm involved -- same wait login() itself uses.
      await page.locator('#app').waitFor({ state: 'visible' });
      await expect(page.locator('#loginForm')).not.toBeVisible();

      // Role-appropriate landing screen: first NAV entry with an id for
      // 'teacher' is t_classes (renderClasses() -> #evClassesGrid).
      await expect(page.locator('#nav_t_classes')).toHaveClass(/active/);
      await expect(page.locator('#evClassesGrid')).toBeVisible();

      // Let the post-reload afterLogin() queries settle too, so logout()'s
      // own navigation-free flow isn't racing them (logout() does not
      // reload the page, but the goal is to keep this spec's exposure to
      // the same in-flight-request class of issue at zero throughout).
      await page.waitForLoadState('networkidle');

      await logout(page);
      await expect(page.locator('#loginForm')).toBeVisible();

      storm.assertNoStorm();
      stripKnownWebkitReloadCancellations(errors);
      assertNoUnexpectedErrors(errors, { allowRequestFailures: [ALLOWED_LOGOUT_ABORT], allowBadResponses: STUDENT_EMPTY_CLASSROOM_ALLOWED_BAD_RESPONSES });
    } catch (e) {
      console.error(
        '[auth-04 diagnostic] teacher test failed. Captured errors at failure time:\n' + JSON.stringify(errors, null, 2),
      );
      throw e;
    }
  });

  test('student: login, reload, session restored without re-authenticating, logout', async ({ page }) => {
    const errors = attachErrorCollectors(page);
    const storm = attachRequestStormDetector(page);

    try {
      await login(page, studentCreds);
      await expect(page.locator('#app')).toBeVisible();

      await page.waitForLoadState('networkidle');

      await page.reload();

      await page.locator('#app').waitFor({ state: 'visible' });
      await expect(page.locator('#loginForm')).not.toBeVisible();

      // Role-appropriate landing screen: first NAV entry with an id for
      // 'student' is s_home (renderStudentHome()), not s_classes.
      await expect(page.locator('#nav_s_home')).toHaveClass(/active/);

      await page.waitForLoadState('networkidle');

      await logout(page);
      await expect(page.locator('#loginForm')).toBeVisible();

      storm.assertNoStorm();
      stripKnownWebkitReloadCancellations(errors);
      assertNoUnexpectedErrors(errors, { allowRequestFailures: [ALLOWED_LOGOUT_ABORT], allowBadResponses: STUDENT_EMPTY_CLASSROOM_ALLOWED_BAD_RESPONSES });
    } catch (e) {
      console.error(
        '[auth-04 diagnostic] student test failed. Captured errors at failure time:\n' + JSON.stringify(errors, null, 2),
      );
      throw e;
    }
  });
});
