import { test, expect, type Page } from '@playwright/test';
import { login, requireTeacherCredentials, requireStudentCredentials } from '../helpers/auth';

const teacherCreds = requireTeacherCredentials();
const studentCreds = requireStudentCredentials();

declare const S: any;
declare const sb: any;

async function waitForNotifyReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () => typeof S !== 'undefined' && S._notifyReady === true && S._bcState === 'healthy' && S._caState === 'healthy',
    null,
    { timeout: 20_000 },
  );
}

async function getOwnProfile(page: Page): Promise<{ id: string }> {
  return page.evaluate(() => ({ id: S.profile.id }));
}

async function readAttemptState(page: Page, id: string): Promise<{ state: string; end_reason: string | null } | null> {
  return page.evaluate(async (attemptId) => {
    const { data } = await (sb as any).from('call_attempts').select('state,end_reason').eq('id', attemptId).maybeSingle();
    return data;
  }, id);
}

async function cleanupAttempt(page: Page, id: string | null): Promise<void> {
  if (!id) return;
  try {
    await page.evaluate(async (attemptId) => {
      try {
        await (sb as any).rpc('fail_call', { p_attempt_id: attemptId, p_reason: 'test_cleanup' });
      } catch {
        /* ignore -- row may already be terminal */
      }
    }, id);
  } catch {
    /* page may already be closed */
  }
}

// Regression coverage for the stale call_attempts recovery fix
// (index.html _reconcileActiveCallAttempt, commit 3a8aed15 on
// call-attempts-architecture). Root cause: with no staleness bound,
// any 'ringing'/'accepted' row left over from an interrupted prior
// test run was silently auto-restored on the next login by the same
// shared CI fixture account, popping #callWindow open and blocking
// unrelated UI (e.g. the P0 logout button). The fix adds two bounds:
//   ringing:  stale after 90s  -> auto fail_call, never restored
//   accepted: stale after 2h   -> auto fail_call, never restored
//             (2h matches the deployed Daily room lifetime; anything
//             shorter would wrongly kill legitimate long lessons)
// These tests fast-forward the *client's* Date.now() via
// page.addInitScript rather than waiting in real time or writing to
// call_attempts directly (RLS on this table only grants SELECT to
// participants -- all state changes must go through the SECURITY
// DEFINER RPCs), so they stay fast and deterministic.
test.describe('CALL recovery -- stale-state reconciliation', () => {
  test('a stale ringing attempt (>90s) is not restored and is auto-failed', async ({ browser }) => {
    const teacherContext = await browser.newContext();
    const studentContext = await browser.newContext();
    const teacherPage = await teacherContext.newPage();
    const studentPage = await studentContext.newPage();
    let attemptId: string | null = null;
    try {
      await Promise.all([login(teacherPage, teacherCreds), login(studentPage, studentCreds)]);
      await Promise.all([waitForNotifyReady(teacherPage), waitForNotifyReady(studentPage)]);
      const studentProfile = await getOwnProfile(studentPage);
      await teacherPage.waitForFunction((sid) => Array.isArray(S.contacts) && S.contacts.some((c: any) => c.id === sid), studentProfile.id, { timeout: 20_000 });

      await teacherPage.locator('.ev-class-card:not(.ev-class-create)').first().click();
      await teacherPage.locator('#cv_callPanel .cv-call-btn').click();
      await expect(studentPage.locator('#incomingCall')).toHaveClass(/show/, { timeout: 20_000 });
      attemptId = await teacherPage.evaluate(() => S._callAttemptId);
      expect(attemptId).toBeTruthy();

      // Simulate the attempt having gone stale (>90s old) by fast-forwarding
      // the teacher's own clock, then reloading -- this is exactly the
      // "next login finds an old ringing row" scenario that broke P0.
      await teacherPage.addInitScript(() => {
        const real = Date.now;
        (Date as any).now = () => real() + 91_000;
      });
      await teacherPage.reload();
      await teacherPage.waitForFunction(() => typeof S !== 'undefined' && !!S.profile?.id, null, { timeout: 20_000 });
      await waitForNotifyReady(teacherPage);

      // Give the reconcile pass a moment to run and hit fail_call, then assert
      // it never showed the call UI and terminated the row itself.
      await expect(teacherPage.locator('#callWindow')).not.toHaveClass(/visible/, { timeout: 5_000 });
      await expect.poll(async () => (await readAttemptState(teacherPage, attemptId!))?.state, { timeout: 15_000 }).toBe('failed');
      const finalRow = await readAttemptState(teacherPage, attemptId!);
      expect(finalRow?.end_reason).toBe('stale_ringing_timeout');
    } finally {
      await cleanupAttempt(teacherPage, attemptId);
      await teacherContext.close();
      await studentContext.close();
    }
  });

  test('a fresh ringing attempt (<90s) still restores normally', async ({ browser }) => {
    const teacherContext = await browser.newContext();
    const studentContext = await browser.newContext();
    const teacherPage = await teacherContext.newPage();
    const studentPage = await studentContext.newPage();
    let attemptId: string | null = null;
    try {
      await Promise.all([login(teacherPage, teacherCreds), login(studentPage, studentCreds)]);
      await Promise.all([waitForNotifyReady(teacherPage), waitForNotifyReady(studentPage)]);
      const studentProfile = await getOwnProfile(studentPage);
      await teacherPage.waitForFunction((sid) => Array.isArray(S.contacts) && S.contacts.some((c: any) => c.id === sid), studentProfile.id, { timeout: 20_000 });

      await teacherPage.locator('.ev-class-card:not(.ev-class-create)').first().click();
      await teacherPage.locator('#cv_callPanel .cv-call-btn').click();
      await expect(studentPage.locator('#incomingCall')).toHaveClass(/show/, { timeout: 20_000 });
      attemptId = await teacherPage.evaluate(() => S._callAttemptId);
      expect(attemptId).toBeTruthy();

      await teacherPage.reload();
      await teacherPage.waitForFunction(() => typeof S !== 'undefined' && !!S.profile?.id, null, { timeout: 20_000 });
      await waitForNotifyReady(teacherPage);

      await expect(teacherPage.locator('#callWindow')).toHaveClass(/visible/, { timeout: 20_000 });
      const row = await readAttemptState(teacherPage, attemptId);
      expect(row?.state).toBe('ringing');

      await studentPage.locator('#incomingCall .btn-red').click();
      await expect(teacherPage.locator('#callWindow')).not.toHaveClass(/visible/, { timeout: 20_000 });
    } finally {
      await cleanupAttempt(teacherPage, attemptId);
      await teacherContext.close();
      await studentContext.close();
    }
  });

  test('an accepted call older than 2 minutes but younger than 2 hours still restores', async ({ browser }) => {
    const teacherContext = await browser.newContext();
    const studentContext = await browser.newContext();
    const teacherPage = await teacherContext.newPage();
    const studentPage = await studentContext.newPage();
    let attemptId: string | null = null;
    try {
      await Promise.all([login(teacherPage, teacherCreds), login(studentPage, studentCreds)]);
      await Promise.all([waitForNotifyReady(teacherPage), waitForNotifyReady(studentPage)]);
      const studentProfile = await getOwnProfile(studentPage);
      await teacherPage.waitForFunction((sid) => Array.isArray(S.contacts) && S.contacts.some((c: any) => c.id === sid), studentProfile.id, { timeout: 20_000 });

      await teacherPage.locator('.ev-class-card:not(.ev-class-create)').first().click();
      await teacherPage.locator('#cv_callPanel .cv-call-btn').click();
      await expect(studentPage.locator('#incomingCall')).toHaveClass(/show/, { timeout: 20_000 });
      await studentPage.locator('#incomingCall .btn-green').click();
      await expect(studentPage.locator('#jitsiFrame')).toHaveAttribute('src', /daily\.co/, { timeout: 15_000 });
      attemptId = await studentPage.evaluate(() => S._callAttemptId);
      expect(attemptId).toBeTruthy();

      // 3 minutes: past the ringing-style short timeout that a naive blanket
      // cutoff would have wrongly applied here, but nowhere near the 2h Daily
      // room lifetime -- this attempt must still be treated as legitimately
      // in-progress and restored.
      await studentPage.addInitScript(() => {
        const real = Date.now;
        (Date as any).now = () => real() + 3 * 60_000;
      });
      await studentPage.reload();
      await studentPage.waitForFunction(() => typeof S !== 'undefined' && !!S.profile?.id, null, { timeout: 20_000 });
      await waitForNotifyReady(studentPage);

      await expect(studentPage.locator('#callWindow')).toHaveClass(/visible/, { timeout: 20_000 });
      const row = await readAttemptState(studentPage, attemptId);
      expect(row?.state).toBe('accepted');

      await teacherPage.locator('#callHeader button.chbtn').last().click();
      await expect(studentPage.locator('#callWindow')).not.toHaveClass(/visible/, { timeout: 20_000 });
    } finally {
      await cleanupAttempt(teacherPage, attemptId);
      await teacherContext.close();
      await studentContext.close();
    }
  });

  test('an accepted call past the Daily room lifetime (>2h) is not restored and is auto-failed', async ({ browser }) => {
    const teacherContext = await browser.newContext();
    const studentContext = await browser.newContext();
    const teacherPage = await teacherContext.newPage();
    const studentPage = await studentContext.newPage();
    let attemptId: string | null = null;
    try {
      await Promise.all([login(teacherPage, teacherCreds), login(studentPage, studentCreds)]);
      await Promise.all([waitForNotifyReady(teacherPage), waitForNotifyReady(studentPage)]);
      const studentProfile = await getOwnProfile(studentPage);
      await teacherPage.waitForFunction((sid) => Array.isArray(S.contacts) && S.contacts.some((c: any) => c.id === sid), studentProfile.id, { timeout: 20_000 });

      await teacherPage.locator('.ev-class-card:not(.ev-class-create)').first().click();
      await teacherPage.locator('#cv_callPanel .cv-call-btn').click();
      await expect(studentPage.locator('#incomingCall')).toHaveClass(/show/, { timeout: 20_000 });
      await studentPage.locator('#incomingCall .btn-green').click();
      await expect(studentPage.locator('#jitsiFrame')).toHaveAttribute('src', /daily\.co/, { timeout: 15_000 });
      attemptId = await studentPage.evaluate(() => S._callAttemptId);
      expect(attemptId).toBeTruthy();

      // 2h5m: past the deployed Daily room lifetime (2h). At this age the
      // room itself would already be dead, so the fix must treat the
      // attempt as expired rather than silently reopening a dead call.
      await studentPage.addInitScript(() => {
        const real = Date.now;
        (Date as any).now = () => real() + (2 * 60 * 60_000 + 5 * 60_000);
      });
      await studentPage.reload();
      await studentPage.waitForFunction(() => typeof S !== 'undefined' && !!S.profile?.id, null, { timeout: 20_000 });
      await waitForNotifyReady(studentPage);

      await expect(studentPage.locator('#callWindow')).not.toHaveClass(/visible/, { timeout: 5_000 });
      await expect.poll(async () => (await readAttemptState(studentPage, attemptId!))?.state, { timeout: 15_000 }).toBe('failed');
      const finalRow = await readAttemptState(studentPage, attemptId!);
      expect(finalRow?.end_reason).toBe('stale_accepted_expired');
    } finally {
      await cleanupAttempt(teacherPage, attemptId);
      await teacherContext.close();
      await studentContext.close();
    }
  });

  test('plain login with only stale historical attempts never opens #callWindow or blocks logout', async ({ browser }) => {
    // This is the exact regression this fix targets: P0 WebKit failed
    // because a stale ringing row from a previous interrupted CI run
    // popped #callWindow open on a completely unrelated plain login,
    // which then intercepted the logout button click for the full test
    // timeout. Reproduce that shape directly: leave a ringing attempt
    // behind, then do a brand-new login (not a reload) with the clock
    // already fast-forwarded past the staleness bound from page load.
    const staleContext = await browser.newContext();
    const studentContext = await browser.newContext();
    const stalePage = await staleContext.newPage();
    const studentPage = await studentContext.newPage();
    let attemptId: string | null = null;
    try {
      await Promise.all([login(stalePage, teacherCreds), login(studentPage, studentCreds)]);
      await Promise.all([waitForNotifyReady(stalePage), waitForNotifyReady(studentPage)]);
      const studentProfile = await getOwnProfile(studentPage);
      await stalePage.waitForFunction((sid) => Array.isArray(S.contacts) && S.contacts.some((c: any) => c.id === sid), studentProfile.id, { timeout: 20_000 });

      await stalePage.locator('.ev-class-card:not(.ev-class-create)').first().click();
      await stalePage.locator('#cv_callPanel .cv-call-btn').click();
      await expect(studentPage.locator('#incomingCall')).toHaveClass(/show/, { timeout: 20_000 });
      attemptId = await stalePage.evaluate(() => S._callAttemptId);
      expect(attemptId).toBeTruthy();
      await stalePage.close();
      await staleContext.close();

      const freshContext = await browser.newContext();
      const freshPage = await freshContext.newPage();
      try {
        await freshPage.addInitScript(() => {
          const real = Date.now;
          (Date as any).now = () => real() + 91_000;
        });
        await login(freshPage, teacherCreds);
        await waitForNotifyReady(freshPage);

        await expect(freshPage.locator('#callWindow')).not.toHaveClass(/visible/, { timeout: 5_000 });
        await expect.poll(async () => (await readAttemptState(freshPage, attemptId!))?.state, { timeout: 15_000 }).toBe('failed');

        // The original P0 regression: logout must remain clickable.
        await freshPage.locator('button.btn-logout').click();
        await expect(freshPage.locator('#loginForm')).toBeVisible({ timeout: 20_000 });
      } finally {
        await freshContext.close();
      }
    } finally {
      await studentContext.close();
    }
  });
});
