import { test, expect, type Page } from '@playwright/test';
import { attachErrorCollectors, assertNoUnexpectedErrors } from '../helpers/error-collectors';
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

test.describe('CALL-B -- accept, media, hangup, accepted-call reload recovery', () => {
  test('call-b01/b02: accept establishes Daily media on both sides and stays alive >=60s', async ({ browser }) => {
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
      assertNoUnexpectedErrors(teacherErrors, { allow: [/daily\.co/] });
      assertNoUnexpectedErrors(studentErrors, { allow: [/daily\.co/] });
    } finally {
      await teacherContext.close();
      await studentContext.close();
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
      await teacherContext.close();
      await studentContext.close();
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
      await teacherContext.close();
      await studentContext.close();
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
      const attemptId = await teacherPage.waitForFunction(() => (window as any).S._callAttemptId, null, { timeout: 10_000 }).then((h) => h.jsonValue());

      await expect(teacherPage.locator('#callWindow')).not.toHaveClass(/visible/, { timeout: 15_000 });
      await expect.poll(async () => {
        const row = await teacherPage.evaluate(async (id) => {
          const { data } = await (sb as any).from('call_attempts').select('state').eq('id', id).maybeSingle();
          return data;
        }, attemptId);
        return row?.state;
      }).toBe('failed');
    } finally {
      await teacherContext.close();
      await studentContext.close();
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
      const attemptId = await teacherPage.waitForFunction(() => (window as any).S._callAttemptId, null, { timeout: 10_000 }).then((h) => h.jsonValue());

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
      await teacherContext.close();
      await studentContext.close();
    }
  });
});
