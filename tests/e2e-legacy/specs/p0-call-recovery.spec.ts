import { test, expect, type Page } from '@playwright/test';
import { login, requireTeacherCredentials, requireStudentCredentials, requireStrangerCredentials } from '../helpers/auth';

const teacherCreds = requireTeacherCredentials();
const studentCreds = requireStudentCredentials();
const strangerCreds = requireStrangerCredentials();

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

test.describe('CALL recovery -- reconnect, reload, stale/duplicate events', () => {
  test('reload during ringing (callee side) re-shows the incoming call', async ({ browser }) => {
    const teacherContext = await browser.newContext();
    const studentContext = await browser.newContext();
    const teacherPage = await teacherContext.newPage();
    const studentPage = await studentContext.newPage();
    try {
      await Promise.all([login(teacherPage, teacherCreds), login(studentPage, studentCreds)]);
      await Promise.all([waitForNotifyReady(teacherPage), waitForNotifyReady(studentPage)]);
      const studentProfile = await getOwnProfile(studentPage);
      await teacherPage.waitForFunction((sid) => Array.isArray(S.contacts) && S.contacts.some((c: any) => c.id === sid), studentProfile.id, { timeout: 20_000 });

      await teacherPage.locator('.ev-class-card:not(.ev-class-create)').first().click();
      await teacherPage.locator('#cv_callPanel .cv-call-btn').click();
      await expect(studentPage.locator('#incomingCall')).toHaveClass(/show/, { timeout: 20_000 });

      await studentPage.reload();
      await studentPage.waitForFunction(() => typeof S !== 'undefined' && !!S.profile?.id, null, { timeout: 20_000 });
      await waitForNotifyReady(studentPage);

      await expect(studentPage.locator('#incomingCall')).toHaveClass(/show/, { timeout: 20_000 });

      await studentPage.locator('#incomingCall .btn-red').click();
      await expect(teacherPage.locator('#callWindow')).not.toHaveClass(/visible/, { timeout: 20_000 });
    } finally {
      await teacherContext.close();
      await studentContext.close();
    }
  });

  test('reload during accepted call recovers without a new start_call/accept_call and rejoins the same Daily room', async ({ browser }) => {
    const teacherContext = await browser.newContext();
    const studentContext = await browser.newContext();
    const teacherPage = await teacherContext.newPage();
    const studentPage = await studentContext.newPage();
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

      const attemptId = await studentPage.evaluate(() => S._callAttemptId);
      const roomId = await studentPage.evaluate(() => S._callRoomId);

      let startCallCalls = 0;
      let acceptCallCalls = 0;
      studentPage.on('request', (req) => {
        if (req.method() !== 'POST') return;
        if (req.url().includes('/rest/v1/rpc/start_call')) startCallCalls++;
        if (req.url().includes('/rest/v1/rpc/accept_call')) acceptCallCalls++;
      });

      await studentPage.reload();
      await studentPage.waitForFunction(() => typeof S !== 'undefined' && !!S.profile?.id, null, { timeout: 20_000 });
      await waitForNotifyReady(studentPage);

      await expect.poll(async () => studentPage.evaluate(() => S._callAttemptId)).toBe(attemptId);
      await expect.poll(async () => studentPage.evaluate(() => S._callRoomId)).toBe(roomId);
      await expect(studentPage.locator('#callWindow')).toHaveClass(/visible/, { timeout: 20_000 });
      await expect(studentPage.locator('#jitsiFrame')).toHaveAttribute('src', /daily\.co/, { timeout: 15_000 });

      expect(startCallCalls).toBe(0);
      expect(acceptCallCalls).toBe(0);

      const rowAfterRejoin = await studentPage.evaluate(async (id) => {
        const { data } = await (sb as any).from('call_attempts').select('state').eq('id', id).maybeSingle();
        return data;
      }, attemptId);
      expect(rowAfterRejoin?.state).toBe('accepted');

      await teacherPage.locator('#callHeader button.chbtn').last().click();
      await expect(studentPage.locator('#callWindow')).not.toHaveClass(/visible/, { timeout: 20_000 });
    } finally {
      await teacherContext.close();
      await studentContext.close();
    }
  });

  test('caller reload while callee still ringing restores the same attempt without a second start_call; callee decline then closes the restored caller UI', async ({ browser }) => {
    const teacherContext = await browser.newContext();
    const studentContext = await browser.newContext();
    const teacherPage = await teacherContext.newPage();
    const studentPage = await studentContext.newPage();
    try {
      await Promise.all([login(teacherPage, teacherCreds), login(studentPage, studentCreds)]);
      await Promise.all([waitForNotifyReady(teacherPage), waitForNotifyReady(studentPage)]);
      const studentProfile = await getOwnProfile(studentPage);
      await teacherPage.waitForFunction((sid) => Array.isArray(S.contacts) && S.contacts.some((c: any) => c.id === sid), studentProfile.id, { timeout: 20_000 });

      let startCallCalls = 0;
      teacherPage.on('request', (req) => {
        if (req.method() === 'POST' && req.url().includes('/rest/v1/rpc/start_call')) startCallCalls++;
      });

      await teacherPage.locator('.ev-class-card:not(.ev-class-create)').first().click();
      await teacherPage.locator('#cv_callPanel .cv-call-btn').click();
      await expect(studentPage.locator('#incomingCall')).toHaveClass(/show/, { timeout: 20_000 });
      expect(startCallCalls).toBe(1);

      const attemptId = await teacherPage.evaluate(() => S._callAttemptId);
      const roomId = await teacherPage.evaluate(() => S._callRoomId);
      expect(attemptId).toBeTruthy();

      await teacherPage.reload();
      await teacherPage.waitForFunction(() => typeof S !== 'undefined' && !!S.profile?.id, null, { timeout: 20_000 });
      await waitForNotifyReady(teacherPage);

      await expect.poll(async () => teacherPage.evaluate(() => S._callAttemptId)).toBe(attemptId);
      await expect.poll(async () => teacherPage.evaluate(() => S._callRoomId)).toBe(roomId);
      await expect(teacherPage.locator('#callWindow')).toHaveClass(/visible/, { timeout: 20_000 });
      expect(startCallCalls).toBe(1);

      const rowAfterRestore = await teacherPage.evaluate(async (id) => {
        const { data } = await (sb as any).from('call_attempts').select('state').eq('id', id).maybeSingle();
        return data;
      }, attemptId);
      expect(rowAfterRestore?.state).toBe('ringing');

      await studentPage.locator('#incomingCall .btn-red').click();
      await expect(teacherPage.locator('#callWindow')).not.toHaveClass(/visible/, { timeout: 20_000 });
      await expect.poll(async () => teacherPage.evaluate(() => S.inCall)).toBe(false);

      const finalRow = await teacherPage.evaluate(async (id) => {
        const { data } = await (sb as any).from('call_attempts').select('state').eq('id', id).maybeSingle();
        return data;
      }, attemptId);
      expect(finalRow?.state).toBe('declined');
    } finally {
      await teacherContext.close();
      await studentContext.close();
    }
  });

  test('a non-participant cannot read, rejoin via daily-room, or act via RPC on another pair\'s call_attempts row', async ({ browser }) => {
    const teacherContext = await browser.newContext();
    const studentContext = await browser.newContext();
    const strangerContext = await browser.newContext();
    const teacherPage = await teacherContext.newPage();
    const studentPage = await studentContext.newPage();
    const strangerPage = await strangerContext.newPage();
    try {
      await Promise.all([login(teacherPage, teacherCreds), login(studentPage, studentCreds), login(strangerPage, strangerCreds)]);
      await Promise.all([waitForNotifyReady(teacherPage), waitForNotifyReady(studentPage)]);
      const studentProfile = await getOwnProfile(studentPage);
      await teacherPage.waitForFunction((sid) => Array.isArray(S.contacts) && S.contacts.some((c: any) => c.id === sid), studentProfile.id, { timeout: 20_000 });

      await teacherPage.locator('.ev-class-card:not(.ev-class-create)').first().click();
      await teacherPage.locator('#cv_callPanel .cv-call-btn').click();
      await expect(studentPage.locator('#incomingCall')).toHaveClass(/show/, { timeout: 20_000 });
      const attemptId = await teacherPage.evaluate(() => S._callAttemptId);
      const roomId = await teacherPage.evaluate(() => S._callRoomId);

      const selectResult = await strangerPage.evaluate(async (id) => {
        const { data, error } = await (sb as any).from('call_attempts').select('*').eq('id', id);
        return { rowCount: data?.length ?? null, error: error?.message ?? null };
      }, attemptId);
      expect(selectResult.error).toBeNull();
      expect(selectResult.rowCount).toBe(0);

      const dailyResult = await strangerPage.evaluate(async ({ roomId, attemptId }) => {
        const { data, error } = await (sb as any).functions.invoke('daily-room', { body: { roomId, attemptId } });
        let status: number | null = null;
        try { status = (error as any)?.context?.status ?? null; } catch { /* ignore */ }
        return { hasUrl: !!data?.url, errorStatus: status };
      }, { roomId, attemptId });
      expect(dailyResult.hasUrl).toBe(false);
      expect(dailyResult.errorStatus).toBe(403);

      const rpcResults = await strangerPage.evaluate(async (id) => {
        const out: Record<string, { error: string | null }> = {};
        for (const fn of ['accept_call', 'decline_call', 'end_call']) {
          const { error } = await (sb as any).rpc(fn, { p_id: id });
          out[fn] = { error: error?.message ?? null };
        }
        return out;
      }, attemptId);
      expect(rpcResults.accept_call.error).toBeTruthy();
      expect(rpcResults.decline_call.error).toBeTruthy();
      expect(rpcResults.end_call.error).toBeTruthy();

      const rowAfter = await teacherPage.evaluate(async (id) => {
        const { data } = await (sb as any).from('call_attempts').select('state').eq('id', id).maybeSingle();
        return data;
      }, attemptId);
      expect(rowAfter?.state).toBe('ringing');

      await studentPage.locator('#incomingCall .btn-red').click();
      await expect(teacherPage.locator('#callWindow')).not.toHaveClass(/visible/, { timeout: 20_000 });
    } finally {
      await teacherContext.close();
      await studentContext.close();
      await strangerContext.close();
    }
  });
});
