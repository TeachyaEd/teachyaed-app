import { test, expect, type Page } from '@playwright/test';
import { attachErrorCollectors, assertNoUnexpectedErrors, type AllowedBadResponse } from '../helpers/error-collectors';
import { attachRequestStormDetector, attachRealtimeSubscriptionTracker } from '../helpers/request-storm-detector';
import { login, requireTeacherCredentials, requireStudentCredentials } from '../helpers/auth';

// CALL-B -- accept, Daily media, hangup propagation, and accepted-call
// reload recovery. Same real UI path, same lexical S/sb page-context
// pattern, same helpers/conventions as CALL-A (p0-call-a.spec.ts) -- see
// that file's header comment for the full UI-path source trace, not
// repeated here.

const teacherCreds = requireTeacherCredentials();
const studentCreds = requireStudentCredentials();

declare const S: any;
declare const sb: any;

async function waitForNotifyReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () => typeof S !== 'undefined' && S._notifyReady === true && S._bcState === 'healthy',
    null,
    { timeout: 20_000 },
  );
}

async function getOwnProfile(page: Page): Promise<{ id: string; first_name: string; last_name: string }> {
  return page.evaluate(() => ({ id: S.profile.id, first_name: S.profile.first_name, last_name: S.profile.last_name }));
}

async function placeCallAndGetIncoming(teacherPage: Page, studentPage: Page, studentProfileId: string): Promise<void> {
  await teacherPage.locator('.ev-class-card:not(.ev-class-create)').first().click();
  await expect(teacherPage.locator('#classroomView')).toHaveClass(/open/);
  const callBtn = teacherPage.locator('#cv_callPanel .cv-call-btn');
  await expect(callBtn).toBeVisible();
  await expect(callBtn).toBeEnabled();
  await callBtn.click();
  const which = await Promise.race([
    teacherPage.locator('#contactPicker.open').waitFor({ state: 'attached', timeout: 20_000 }).then(() => 'picker' as const).catch(() => null),
    studentPage.locator('#incomingCall.show').waitFor({ state: 'attached', timeout: 20_000 }).then(() => 'incoming' as const).catch(() => null),
  ]);
  if (which === 'picker') await teacherPage.locator(`.contact-item[data-cid="${studentProfileId}"]`).click();
  await expect(studentPage.locator('#incomingCall')).toHaveClass(/show/, { timeout: 20_000 });
}

async function fetchCallAttemptState(page: Page, roomId: string): Promise<string | null> {
  return page.evaluate(async (rid) => {
    const { data } = await (sb as any).from('call_attempts').select('state').eq('room_id', rid).order('created_at', { ascending: false }).limit(1).maybeSingle();
    return data?.state ?? null;
  }, roomId);
}

// Known, pre-existing 404s from the legacy lesson-content image
// rendering path -- unrelated to the calling subsystem this spec covers.
// '/x' is a documented, intentional onerror-trigger hack (see
// renderBlockView / quiz-timer code in index.html). The three literal
// '${...}' paths are a suspected separate legacy template-escaping bug in
// that same lesson-content rendering code, tracked as a follow-up and
// deliberately NOT investigated/fixed here to keep this change scoped to
// CALL-B. Exact hostname+status+path match only -- see AllowedBadResponse.
const CALL_B_KNOWN_LEGACY_IMAGE_404S: AllowedBadResponse[] = [
  { hostname: '127.0.0.1', status: 404, path: '/x' },
  { hostname: '127.0.0.1', status: 404, path: '/${_escHtml(safeUrl)}' },
  { hostname: '127.0.0.1', status: 404, path: '/${_escHtml(b.image)}' },
  { hostname: '127.0.0.1', status: 404, path: '/${_iUrl}' },
];

test.describe('CALL-B -- accept, media, hangup, accepted-call reload recovery', () => {
  test('call-b01/b02: accept establishes Daily media on both sides and stays alive >=60s', async ({ browser }) => {
    // Intentional >=60s active-call wait loop plus setup (login, accept,
    // media checks) leaves little headroom under the spec's global 90s
    // timeout; extend only this test, not the global config.
    test.setTimeout(150_000);
    const teacherContext = await browser.newContext();
    const studentContext = await browser.newContext();
    const teacherPage = await teacherContext.newPage();
    const studentPage = await studentContext.newPage();
    const teacherErrors = attachErrorCollectors(teacherPage);
    const studentErrors = attachErrorCollectors(studentPage);
    const teacherStorm = attachRequestStormDetector(teacherPage);
    const studentStorm = attachRequestStormDetector(studentPage);

    try {
      await Promise.all([login(teacherPage, teacherCreds), login(studentPage, studentCreds)]);
      await Promise.all([waitForNotifyReady(teacherPage), waitForNotifyReady(studentPage)]);
      const studentProfile = await getOwnProfile(studentPage);
      await teacherPage.waitForFunction((sid) => Array.isArray(S.contacts) && S.contacts.some((c: any) => c.id === sid), studentProfile.id, { timeout: 20_000 });

      await placeCallAndGetIncoming(teacherPage, studentPage, studentProfile.id);
      await studentPage.locator('#incomingCall .btn-green').click();

      await expect(studentPage.locator('#jitsiFrame')).toHaveAttribute('src', /daily\.co/, { timeout: 15_000 });
      await expect(teacherPage.locator('#jitsiFrame')).toHaveAttribute('src', /daily\.co/, { timeout: 15_000 });

      const roomId = await teacherPage.evaluate(() => S._callRoomId);
      await expect.poll(() => fetchCallAttemptState(teacherPage, roomId)).toBe('accepted');

      const start = Date.now();
      while (Date.now() - start < 60_000) {
        await expect(teacherPage.locator('#callWindow')).toHaveClass(/visible/);
        await expect(studentPage.locator('#callWindow')).toHaveClass(/visible/);
        await teacherPage.waitForTimeout(5_000);
      }

      teacherStorm.assertNoStorm();
      studentStorm.assertNoStorm();
      assertNoUnexpectedErrors(teacherErrors, { allow: [/daily\.co/], allowBadResponses: CALL_B_KNOWN_LEGACY_IMAGE_404S });
      assertNoUnexpectedErrors(studentErrors, { allow: [/daily\.co/], allowBadResponses: CALL_B_KNOWN_LEGACY_IMAGE_404S });

      // Explicitly hang up and wait for the attempt to reach a terminal
      // state before teardown. Without this, this test's call_attempts row
      // is abandoned in 'accepted' state when the contexts close, which
      // causes the next serialized test (call-b03) to hang for the full
      // test timeout on its first call-button click while the app's
      // staleness reconciliation sweeps up the stale row on next login.
      await teacherPage.locator('#callHeader button.chbtn').last().click();
      await expect.poll(() => fetchCallAttemptState(teacherPage, roomId)).toBe('ended');
    } finally {
      await Promise.allSettled([teacherContext.close(), studentContext.close()]);
    }
  });

  test('call-b03: caller hangup propagates to callee; call_attempts ends with correct ended_by', async ({ browser }) => {
    const teacherContext = await browser.newContext();
    const studentContext = await browser.newContext();
    const teacherPage = await teacherContext.newPage();
    const studentPage = await studentContext.newPage();
    try {
      await Promise.all([login(teacherPage, teacherCreds), login(studentPage, studentCreds)]);
      await Promise.all([waitForNotifyReady(teacherPage), waitForNotifyReady(studentPage)]);
      const teacherProfile = await getOwnProfile(teacherPage);
      const studentProfile = await getOwnProfile(studentPage);
      await teacherPage.waitForFunction((sid) => Array.isArray(S.contacts) && S.contacts.some((c: any) => c.id === sid), studentProfile.id, { timeout: 20_000 });

      await placeCallAndGetIncoming(teacherPage, studentPage, studentProfile.id);
      await studentPage.locator('#incomingCall .btn-green').click();
      await expect(teacherPage.locator('#jitsiFrame')).toHaveAttribute('src', /daily\.co/, { timeout: 15_000 });

      const attemptId = await teacherPage.evaluate(() => S._callAttemptId);
      await teacherPage.locator('#callHeader button.chbtn').last().click();

      await expect(studentPage.locator('#callWindow')).not.toHaveClass(/visible/, { timeout: 20_000 });
      await expect.poll(async () => {
        const row = await studentPage.evaluate(async (id) => {
          const { data } = await (sb as any).from('call_attempts').select('state,ended_by').eq('id', id).maybeSingle();
          return data;
        }, attemptId);
        return row?.state;
      }).toBe('ended');
      const finalRow = await studentPage.evaluate(async (id) => {
        const { data } = await (sb as any).from('call_attempts').select('ended_by').eq('id', id).maybeSingle();
        return data;
      }, attemptId);
      expect(finalRow?.ended_by).toBe(teacherProfile.id);
    } finally {
      await Promise.allSettled([teacherContext.close(), studentContext.close()]);
    }
  });

  test('call-b04: recipient hangup propagates to caller', async ({ browser }) => {
    const teacherContext = await browser.newContext();
    const studentContext = await browser.newContext();
    const teacherPage = await teacherContext.newPage();
    const studentPage = await studentContext.newPage();
    try {
      await Promise.all([login(teacherPage, teacherCreds), login(studentPage, studentCreds)]);
      await Promise.all([waitForNotifyReady(teacherPage), waitForNotifyReady(studentPage)]);
      const studentProfile = await getOwnProfile(studentPage);
      await teacherPage.waitForFunction((sid) => Array.isArray(S.contacts) && S.contacts.some((c: any) => c.id === sid), studentProfile.id, { timeout: 20_000 });

      await placeCallAndGetIncoming(teacherPage, studentPage, studentProfile.id);
      await studentPage.locator('#incomingCall .btn-green').click();
      await expect(studentPage.locator('#jitsiFrame')).toHaveAttribute('src', /daily\.co/, { timeout: 15_000 });

      await studentPage.locator('#callHeader button.chbtn').last().click();
      await expect(teacherPage.locator('#callWindow')).not.toHaveClass(/visible/, { timeout: 20_000 });
    } finally {
      await Promise.allSettled([teacherContext.close(), studentContext.close()]);
    }
  });

  test('call-b05: daily-room failure marks the attempt failed and reconciles the caller', async ({ browser }) => {
    const teacherContext = await browser.newContext();
    const studentContext = await browser.newContext();
    const teacherPage = await teacherContext.newPage();
    const studentPage = await studentContext.newPage();
    try {
      await Promise.all([login(teacherPage, teacherCreds), login(studentPage, studentCreds)]);
      await Promise.all([waitForNotifyReady(teacherPage), waitForNotifyReady(studentPage)]);
      const studentProfile = await getOwnProfile(studentPage);
      await teacherPage.waitForFunction((sid) => Array.isArray(S.contacts) && S.contacts.some((c: any) => c.id === sid), studentProfile.id, { timeout: 20_000 });

      await teacherPage.route('**/functions/v1/daily-room', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"forced test failure"}' }));

      await teacherPage.locator('.ev-class-card:not(.ev-class-create)').first().click();
      await teacherPage.locator('#cv_callPanel .cv-call-btn').click();
      await teacherPage.waitForFunction(
        () => typeof S !== 'undefined' && !!S._callAttemptId,
        null,
        { timeout: 10_000 },
      );
      const attemptId = await teacherPage.evaluate(() => S._callAttemptId);

      await expect(teacherPage.locator('#callWindow')).not.toHaveClass(/visible/, { timeout: 15_000 });
      await expect.poll(async () => {
        const row = await teacherPage.evaluate(async (id) => {
          const { data } = await (sb as any).from('call_attempts').select('state').eq('id', id).maybeSingle();
          return data;
        }, attemptId);
        return row?.state;
      }).toBe('failed');
    } finally {
      await Promise.allSettled([teacherContext.close(), studentContext.close()]);
    }
  });

  test('call-b06: Daily setup failure always ends in failed, never ended, even checked repeatedly', async ({ browser }) => {
    const teacherContext = await browser.newContext();
    const studentContext = await browser.newContext();
    const teacherPage = await teacherContext.newPage();
    const studentPage = await studentContext.newPage();
    try {
      await Promise.all([login(teacherPage, teacherCreds), login(studentPage, studentCreds)]);
      await Promise.all([waitForNotifyReady(teacherPage), waitForNotifyReady(studentPage)]);
      const studentProfile = await getOwnProfile(studentPage);
      await teacherPage.waitForFunction((sid) => Array.isArray(S.contacts) && S.contacts.some((c: any) => c.id === sid), studentProfile.id, { timeout: 20_000 });

      await teacherPage.route('**/functions/v1/daily-room', (route) =>
        route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"forced test failure"}' }),
      );

      await teacherPage.locator('.ev-class-card:not(.ev-class-create)').first().click();
      await teacherPage.locator('#cv_callPanel .cv-call-btn').click();
      await teacherPage.waitForFunction(
        () => typeof S !== 'undefined' && !!S._callAttemptId,
        null,
        { timeout: 10_000 },
      );
      const attemptId = await teacherPage.evaluate(() => S._callAttemptId);

      await expect(teacherPage.locator('#callWindow')).not.toHaveClass(/visible/, { timeout: 15_000 });

      const stateNow = await teacherPage.evaluate(async (id) => {
        const { data } = await (sb as any).from('call_attempts').select('state,end_reason').eq('id', id).maybeSingle();
        return data;
      }, attemptId);
      expect(stateNow?.state).toBe('failed');
      expect(stateNow?.end_reason).toBe('daily_room_error');

      await teacherPage.waitForTimeout(2_000);
      const stateLater = await teacherPage.evaluate(async (id) => {
        const { data } = await (sb as any).from('call_attempts').select('state').eq('id', id).maybeSingle();
        return data;
      }, attemptId);
      expect(stateLater?.state).toBe('failed');
    } finally {
      await Promise.allSettled([teacherContext.close(), studentContext.close()]);
    }
  });
});
