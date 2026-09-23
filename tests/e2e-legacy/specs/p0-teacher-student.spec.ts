import { test, expect } from '@playwright/test';
import { attachErrorCollectors, assertNoUnexpectedErrors } from '../helpers/error-collectors';
import { attachRequestStormDetector } from '../helpers/request-storm-detector';
import { login, logout, requireTeacherCredentials, requireStudentCredentials } from '../helpers/auth';

// First real authenticated P0 slice against staging. Scope is deliberately
// narrow -- teacher and student login, dashboard, opening a class with no
// live lesson, seeing the empty classroom shell, and logout. No homework,
// messenger, calls, materials, or broader navigation here.
//
// Zero-tolerance, unlike specs/smoke.spec.ts: this spec does NOT install
// the 4-URL local-parser-noise allow-list from the smoke spec. That
// allow-list is scoped to the pre-login smoke page load only and must
// never leak into an authenticated P0 spec (see smoke.spec.ts's own
// comment). assertNoUnexpectedErrors() below is called with no options,
// so any pageerror, any console.error, any bad HTTP response, and any
// request storm fails this spec outright -- including RLS/DB errors,
// which are never hidden behind an allow-list here.
//
// Selectors: #loginEmail/#loginPass/button.btn-login/#loginErr/#app/
// button.btn-logout/#loginForm are pre-existing stable IDs, confirmed
// directly against the live production index.html source (see auth.ts).
// #evClassesGrid, #classroomView and #cv_lessonName are likewise
// pre-existing stable IDs. The teacher class-card selector below
// (.ev-class-card:not(.ev-class-create)) is a CSS class rather than a
// dedicated data-testid -- adding a data-testid hook to root index.html
// for this was attempted and blocked by this session's own tooling
// permissions (see delivery notes), so this is a documented fallback,
// not an unexamined shortcut.
//
// 2026-09-23: the student flow now explicitly navigates to the
// #nav_s_classes sidebar item before looking for the "▶️ В урок" button.
// Traced from source: afterLogin() calls showScreen(firstItem.id), and
// for role=student the first NAV entry with an id is s_home (dispatches
// to renderStudentHome()), not s_classes (renderStudentClasses()) --
// the "В урок" button only exists in the DOM rendered by the latter,
// reached only by clicking the "Мой класс" nav item. Looking for the
// button immediately after login was targeting the wrong screen; this
// was a test bug, not a fixture, RLS, or app-logic issue.
//
// Requires 4 dedicated staging-only test identities via env vars (never
// hardcoded, never logged): STAGING_TEACHER_EMAIL, STAGING_TEACHER_PASSWORD,
// STAGING_STUDENT_EMAIL, STAGING_STUDENT_PASSWORD. Fail-fast, not skip:
// requireTeacherCredentials()/requireStudentCredentials() throw at module
// load time (before any test runs) naming exactly which variable(s) are
// missing if any are unset -- a green run with both tests silently
// skipped is not an acceptable release gate. The workflow also runs its
// own preflight step checking the same 4 secrets before this spec even
// gets a chance to load (see .github/workflows/staging-e2e.yml).
//
// Requires staging fixture data this spec does not create, seed, or
// verify at runtime: one school; the test teacher's profile in that
// school; the test student's profile + matching students row in that
// school; one class taught by the test teacher; a class_students row
// enrolling the test student in that class; and deliberately NO
// class_lessons / lesson_assignments / class_live rows for that class,
// so the "no live lesson" / "empty classroom shell" scenario is exercised
// deterministically. See the fixture report delivered alongside this
// spec for the exact minimal data and a read-only SQL check for it.
//
// Failure diagnostics: each test body below wraps its assertions in a
// try/catch. On any thrown error (including a normal Playwright
// assertion timeout), the catch prints the errors object already
// captured live by attachErrorCollectors() -- pageErrors, consoleErrors,
// badResponses, requestFailures -- as of the moment of failure, then
// rethrows the original error completely unchanged. This is diagnostic
// only: it does not suppress, downgrade, or filter anything, and
// assertNoUnexpectedErrors(errors) at the end of the try block is
// unchanged and still fatal on any captured error when it is reached.
// Its only purpose is to make already-captured errors visible in the
// failure output when an earlier assertion (e.g. a toHaveClass/
// toBeVisible timeout) throws before assertNoUnexpectedErrors() would
// otherwise have been reached.

const teacherCreds = requireTeacherCredentials();
const studentCreds = requireStudentCredentials();

test.describe('legacy app P0 -- authenticated teacher/student (Chromium only)', () => {
  test('teacher: login, dashboard, open class with no live lesson, empty classroom shell, logout', async ({ page }) => {
    const errors = attachErrorCollectors(page);
    const storm = attachRequestStormDetector(page);

    try {
      await login(page, teacherCreds);

      // Teacher dashboard: renderClasses() renders into #evClassesGrid.
      await expect(page.locator('#evClassesGrid')).toBeVisible();

      const classCard = page.locator('.ev-class-card:not(.ev-class-create)').first();
      await expect(classCard, 'expected at least one class card for the staging teacher fixture').toBeVisible();

      // Clicking the card calls enterClassLesson(classId), which opens the
      // classroom view directly -- class_live is never created or required.
      // See the Russian comment inline in enterClassLesson() in index.html:
      // "Открываем классную комнату сразу, без старта живого урока".
      await classCard.click();

      await expect(page.locator('#classroomView')).toHaveClass(/open/);
      await expect(page.locator('#cv_lessonName')).toBeVisible();

      // #classroomView is a full-viewport fixed overlay (inset:0, z-index:360)
      // that covers the sidebar/logout button while open, so it must be
      // closed first via the real "back" control before logout is reachable.
      await page.getByRole('button', { name: /Выйти из урока/ }).click();
      await expect(page.locator('#classroomView')).not.toHaveClass(/open/);

      await logout(page);
      await expect(page.locator('#loginForm')).toBeVisible();

      storm.assertNoStorm();
      assertNoUnexpectedErrors(errors);
    } catch (e) {
      console.error(
        '[P0 diagnostic] teacher test failed. Captured errors at failure time:\n' + JSON.stringify(errors, null, 2),
      );
      throw e;
    }
  });

  test('student: login, dashboard, open class with no live lesson, empty classroom shell, logout', async ({ page }) => {
    const errors = attachErrorCollectors(page);
    const storm = attachRequestStormDetector(page);

    try {
      await login(page, studentCreds);

      // Navigate to the "Мой класс" screen -- renderStudentClasses() is
      // not the post-login landing screen (that's renderStudentHome(),
      // via s_home). The "В урок" button only exists once this screen
      // has been rendered.
      await page.locator('#nav_s_classes').click();

      const enterButton = page.getByRole('button', { name: /В урок/ }).first();
      await expect(enterButton, 'expected the staging student fixture to see at least one enrolled class').toBeVisible();

      // enterStudentClassLesson() queries class_live but never uses it to
      // gate entry -- a live lesson is read, not required.
      await enterButton.click();

      await expect(page.locator('#classroomView')).toHaveClass(/open/);
      await expect(page.locator('#cv_lessonName')).toBeVisible();

      await page.getByRole('button', { name: /Выйти из урока/ }).click();
      await expect(page.locator('#classroomView')).not.toHaveClass(/open/);

      await logout(page);
      await expect(page.locator('#loginForm')).toBeVisible();

      storm.assertNoStorm();
      assertNoUnexpectedErrors(errors);
    } catch (e) {
      console.error(
        '[P0 diagnostic] student test failed. Captured errors at failure time:\n' + JSON.stringify(errors, null, 2),
      );
      throw e;
    }
  });
});
