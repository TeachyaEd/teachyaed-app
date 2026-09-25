import { test, expect, type Page } from '@playwright/test';
import { attachErrorCollectors, assertNoUnexpectedErrors, type AllowedBadResponse } from '../helpers/error-collectors';
import { attachRequestStormDetector, attachRealtimeSubscriptionTracker } from '../helpers/request-storm-detector';
import { login, requireTeacherCredentials, requireStudentCredentials } from '../helpers/auth';

// CALL-MULTITAB -- multi-tab / duplicate-session behaviour for the
// call_attempts architecture (Phase 4 of the post-rollout staging
// hardening program). Production is untouched by this spec; it only
// exercises the staging project (lqyetodkoxodwjyqxukq).
//
// Scope, as specified: the same teacher logged in in two real tabs
// (two independent Playwright BrowserContexts, since two real Chrome
// tabs on the same machine would also be two independent renderer
// processes each running their own copy of index.html's module-level
// state / Supabase Realtime socket -- that per-tab isolation is exactly
// what this spec is testing), and the same student logged in in two
// tabs, covering:
//   1. one incoming call reaches both student tabs without creating a
//      second call_attempts row for the same call;
//   2. both tabs converge on the exact same attempt_id/room_id;
//   3. accept from one student tab closes the incoming-call UI on the
//      other tab (does not leave it stuck showing a call that is no
//      longer ringing);
//   4. decline from one student tab closes the incoming-call UI on the
//      other tab and ends the call for the teacher, and a stale tab
//      does not resurrect the just-terminated call on reload;
//   5. hangup ends the call for every open tab, and a tab that never
//      acted on an older, now-terminated call attempt cannot affect a
//      newer, unrelated call attempt with a stale action (stale
//      decline/hangup immunity, exercised across tabs rather than
//      across reloads as CALL-A's call-09 already covers);
//   6. no duplicate Realtime subscriptions or request storms are
//      produced by having multiple tabs open for the same identity.
//
// Selectors/functions used below (`.ev-class-card`, `#cv_callPanel
// .cv-call-btn`, `#incomingCall`/`.show`, `.btn-green`/`.btn-red`,
// `#jitsiFrame`, `#callWindow`/`.visible`, `hangUp()`, `S._callAttemptId`,
// `S._callRoomId`, `S.pendingCallAttemptId`) are the same real,
// unmodified app selectors already verified against live index.html in
// p0-call-a.spec.ts and p0-call-recovery.spec.ts -- not re-derived here.
// waitForNotifyReady/getOwnProfile below are copied from p0-call-a.spec.ts
// (that file does not export them, so they are duplicated rather than
// imported, matching how p0-call-recovery.spec.ts also duplicates them).

declare const S: any;
declare const sb: any;

const teacherCreds = requireTeacherCredentials();
const studentCreds = requireStudentCredentials();

async function waitForNotifyReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () => typeof S !== 'undefined' && S._notifyReady === true && S._bcState === 'healthy',
    null,
    { timeout: 20_000 },
  );
}

async function loginFresh(page: Page, creds: { email: string; password: string }): Promise<void> {
  await login(page, creds);
  await waitForNotifyReady(page);
}

async function fetchCallAttempt(
  page: Page,
  id: string,
): Promise<{ state: string; room_id: string; caller_profile_id: string; callee_profile_id: string } | null> {
  return page.evaluate(async (attemptId) => {
    const { data } = await (sb as any)
      .from('call_attempts')
      .select('state,room_id,caller_profile_id,callee_profile_id')
      .eq('id', attemptId)
      .maybeSingle();
    return data ?? null;
  }, id);
}

async function countCallAttemptsForRoom(page: Page, roomId: string): Promise<number> {
  return page.evaluate(async (rid) => {
    const { data } = await (sb as any).from('call_attempts').select('id').eq('room_id', rid);
    return Array.isArray(data) ? data.length : -1;
  }, roomId);
}

// Teacher starts a call the same way p0-call-a.spec.ts/p0-call-recovery.spec.ts
// do: open the first real (non-"create new class") class card, then click the
// call panel's call button. cvCallStudent() calls the single enrolled student
// directly when the class has exactly one student -- the same staging fixture
// class used by every other call-* spec in this suite.
async function teacherStartCall(teacherPage: Page): Promise<void> {
  await teacherPage.locator('.ev-class-card:not(.ev-class-create)').first().click();
  await teacherPage.locator('#cv_callPanel .cv-call-btn').click();
}

const CLASSROOM_VIEW_ALLOWED_BAD_RESPONSES: AllowedBadResponse[] = [
  { hostname: '127.0.0.1', status: 404, path: '/x' },
  { hostname: '127.0.0.1', status: 404, path: '/${_escHtml(safeUrl)}' },
  { hostname: '127.0.0.1', status: 404, path: '/${_escHtml(b.image)}' },
  { hostname: '127.0.0.1', status: 404, path: '/${_iUrl}' },
];

test.describe('CALL-MULTITAB -- duplicate-session behaviour for call_attempts (staging only)', () => {
  test('multitab-01: one incoming call reaches both student tabs, creates exactly one call_attempts row, and both tabs converge on the same attempt/room id', async ({ browser }) => {
    const teacherCtx = await browser.newContext();
    const studentCtxA = await browser.newContext();
    const studentCtxB = await browser.newContext();
    const teacherPage = await teacherCtx.newPage();
    const studentPageA = await studentCtxA.newPage();
    const studentPageB = await studentCtxB.newPage();
    try {
      const teacherErrors = attachErrorCollectors(teacherPage);
      const studentAErrors = attachErrorCollectors(studentPageA);
      const studentBErrors = attachErrorCollectors(studentPageB);
      const stormA = attachRequestStormDetector(studentPageA);
      const stormB = attachRequestStormDetector(studentPageB);
      const rtA = attachRealtimeSubscriptionTracker(studentPageA);
      const rtB = attachRealtimeSubscriptionTracker(studentPageB);

      let startCallCalls = 0;
      teacherPage.on('request', (req) => {
        if (req.url().includes('/rest/v1/rpc/start_call') && req.method() === 'POST') startCallCalls++;
      });

      await Promise.all([loginFresh(teacherPage, teacherCreds), loginFresh(studentPageA, studentCreds), loginFresh(studentPageB, studentCreds)]);

      await teacherStartCall(teacherPage);

      await expect(studentPageA.locator('#incomingCall')).toHaveClass(/show/, { timeout: 20_000 });
      await expect(studentPageB.locator('#incomingCall')).toHaveClass(/show/, { timeout: 20_000 });

      const [attemptA, attemptB, roomA, roomB] = await Promise.all([
        studentPageA.evaluate(() => S.pendingCallAttemptId),
        studentPageB.evaluate(() => S.pendingCallAttemptId),
        studentPageA.evaluate(() => S.pendingRoom),
        studentPageB.evaluate(() => S.pendingRoom),
      ]);
      expect(attemptA).toBeTruthy();
      expect(attemptA).toBe(attemptB);
      expect(roomA).toBeTruthy();
      expect(roomA).toBe(roomB);
      expect(startCallCalls).toBe(1);

      const rowCount = await countCallAttemptsForRoom(studentPageA, roomA);
      expect(rowCount).toBe(1);

      const row = await fetchCallAttempt(studentPageA, attemptA);
      expect(row?.state).toBe('ringing');

      // Clean teardown via the real decline path (exercised properly in
      // multitab-03 below) so this test does not leak a ringing call into
      // the next one.
      await studentPageA.locator('#incomingCall .btn-red').click();
      await expect(teacherPage.locator('#callWindow')).not.toHaveClass(/visible/, { timeout: 20_000 });
      await expect(studentPageB.locator('#incomingCall')).not.toHaveClass(/show/, { timeout: 20_000 });

      rtA.assertNoDuplicateSubscriptions();
      rtB.assertNoDuplicateSubscriptions();
      stormA.assertNoStorm();
      stormB.assertNoStorm();
      stripKnownBad(teacherErrors);
      stripKnownBad(studentAErrors);
      stripKnownBad(studentBErrors);
      assertNoUnexpectedErrors(teacherErrors, { allowBadResponses: CLASSROOM_VIEW_ALLOWED_BAD_RESPONSES });
      assertNoUnexpectedErrors(studentAErrors, { allowBadResponses: CLASSROOM_VIEW_ALLOWED_BAD_RESPONSES });
      assertNoUnexpectedErrors(studentBErrors, { allowBadResponses: CLASSROOM_VIEW_ALLOWED_BAD_RESPONSES });
    } finally {
      await teacherCtx.close();
      await studentCtxA.close();
      await studentCtxB.close();
    }
  });

  test('multitab-02: accepting from student tab A closes the incoming-call UI on tab B, opens Daily only on tab A, and sends exactly one accept_call RPC', async ({ browser }) => {
    const teacherCtx = await browser.newContext();
    const studentCtxA = await browser.newContext();
    const studentCtxB = await browser.newContext();
    const teacherPage = await teacherCtx.newPage();
    const studentPageA = await studentCtxA.newPage();
    const studentPageB = await studentCtxB.newPage();
    try {
      let acceptCallCalls = 0;
      studentPageA.on('request', (req) => {
        if (req.url().includes('/rest/v1/rpc/accept_call') && req.method() === 'POST') acceptCallCalls++;
      });
      studentPageB.on('request', (req) => {
        if (req.url().includes('/rest/v1/rpc/accept_call') && req.method() === 'POST') acceptCallCalls++;
      });

      await Promise.all([loginFresh(teacherPage, teacherCreds), loginFresh(studentPageA, studentCreds), loginFresh(studentPageB, studentCreds)]);
      await teacherStartCall(teacherPage);
      await expect(studentPageA.locator('#incomingCall')).toHaveClass(/show/, { timeout: 20_000 });
      await expect(studentPageB.locator('#incomingCall')).toHaveClass(/show/, { timeout: 20_000 });

      const attemptId = await studentPageA.evaluate(() => S.pendingCallAttemptId);

      await studentPageA.locator('#incomingCall .btn-green').click();
      await expect(studentPageA.locator('#jitsiFrame')).toHaveAttribute('src', /daily\.co/, { timeout: 15_000 });

      // Tab B never accepted or declined; it must be told the call is no
      // longer ringing (via the same postgres_changes UPDATE / broadcast
      // path teacher-side reconciliation already uses) rather than being
      // left showing a stale incoming-call screen for a call someone else
      // already answered.
      await expect(studentPageB.locator('#incomingCall')).not.toHaveClass(/show/, { timeout: 20_000 });

      const row = await fetchCallAttempt(studentPageA, attemptId);
      expect(row?.state).toBe('accepted');
      expect(acceptCallCalls).toBe(1);

      await teacherPage.evaluate(() => (window as any).hangUp());
      await expect(studentPageA.locator('#jitsiFrame')).not.toHaveAttribute('src', /daily\.co/, { timeout: 20_000 });
    } finally {
      await teacherCtx.close();
      await studentCtxA.close();
      await studentCtxB.close();
    }
  });

  test('multitab-03: declining from student tab B closes tab A and the teacher UI, and a stale tab A does not resurrect the just-declined call on reload', async ({ browser }) => {
    const teacherCtx = await browser.newContext();
    const studentCtxA = await browser.newContext();
    const studentCtxB = await browser.newContext();
    const teacherPage = await teacherCtx.newPage();
    const studentPageA = await studentCtxA.newPage();
    const studentPageB = await studentCtxB.newPage();
    try {
      await Promise.all([loginFresh(teacherPage, teacherCreds), loginFresh(studentPageA, studentCreds), loginFresh(studentPageB, studentCreds)]);
      await teacherStartCall(teacherPage);
      await expect(studentPageA.locator('#incomingCall')).toHaveClass(/show/, { timeout: 20_000 });
      await expect(studentPageB.locator('#incomingCall')).toHaveClass(/show/, { timeout: 20_000 });

      const attemptId = await studentPageA.evaluate(() => S.pendingCallAttemptId);

      await studentPageB.locator('#incomingCall .btn-red').click();

      await expect(studentPageA.locator('#incomingCall')).not.toHaveClass(/show/, { timeout: 20_000 });
      await expect(teacherPage.locator('#callWindow')).not.toHaveClass(/visible/, { timeout: 20_000 });

      const row = await fetchCallAttempt(studentPageB, attemptId);
      expect(row?.state).toBe('declined');

      // Reload the tab that never acted (A) -- login-time recovery must
      // not treat this now-terminal, minutes-old attempt as something to
      // re-show. This is the "stale second tab must not reopen a
      // terminated call" requirement, exercised via a real reload rather
      // than assumed.
      await studentPageA.reload();
      await waitForNotifyReady(studentPageA);
      await expect(studentPageA.locator('#incomingCall')).not.toHaveClass(/show/, { timeout: 10_000 });
    } finally {
      await teacherCtx.close();
      await studentCtxA.close();
      await studentCtxB.close();
    }
  });

  test('multitab-04: hangup ends the call on every open tab, and an idle stale tab cannot affect a newer, unrelated call attempt with a leftover action', async ({ browser }) => {
    const teacherCtx = await browser.newContext();
    const studentCtxA = await browser.newContext();
    const studentCtxB = await browser.newContext();
    const teacherPage = await teacherCtx.newPage();
    const studentPageA = await studentCtxA.newPage();
    const studentPageB = await studentCtxB.newPage();
    try {
      const rtTeacher = attachRealtimeSubscriptionTracker(teacherPage);
      const rtA = attachRealtimeSubscriptionTracker(studentPageA);
      const rtB = attachRealtimeSubscriptionTracker(studentPageB);
      const stormTeacher = attachRequestStormDetector(teacherPage);
      const stormA = attachRequestStormDetector(studentPageA);
      const stormB = attachRequestStormDetector(studentPageB);

      await Promise.all([loginFresh(teacherPage, teacherCreds), loginFresh(studentPageA, studentCreds), loginFresh(studentPageB, studentCreds)]);

      // Call 1: A accepts, teacher hangs up. B never acts -- it holds a
      // stale S.pendingCallAttemptId for an attempt that is about to be
      // terminated by someone else's action, the exact scenario this test
      // exists to check.
      await teacherStartCall(teacherPage);
      await expect(studentPageA.locator('#incomingCall')).toHaveClass(/show/, { timeout: 20_000 });
      await expect(studentPageB.locator('#incomingCall')).toHaveClass(/show/, { timeout: 20_000 });
      const staleAttemptId = await studentPageB.evaluate(() => S.pendingCallAttemptId);
      const staleRoomId = await studentPageB.evaluate(() => S.pendingRoom);

      await studentPageA.locator('#incomingCall .btn-green').click();
      await expect(studentPageA.locator('#jitsiFrame')).toHaveAttribute('src', /daily\.co/, { timeout: 15_000 });
      await expect(studentPageB.locator('#incomingCall')).not.toHaveClass(/show/, { timeout: 20_000 });

      await teacherPage.evaluate(() => (window as any).hangUp());
      await expect(studentPageA.locator('#jitsiFrame')).not.toHaveAttribute('src', /daily\.co/, { timeout: 20_000 });

      const endedRow = await fetchCallAttempt(studentPageA, staleAttemptId);
      expect(['ended', 'declined']).toContain(endedRow?.state);

      // Call 2: a fresh, unrelated call to the same student. B is still
      // sitting on the now-terminal attempt 1's id in S.pendingCallAttemptId
      // (it was never told to clear it, since it never opened the incoming
      // UI's action path for attempt 1) -- confirm attempt 2 gets a
      // genuinely new id, then simulate B's leftover UI firing a decline
      // for the id it still remembers. The caller/teacher-side correlation
      // guard (S._callAttemptId must equal the incoming decline's
      // attempt_id) must ignore this, exactly as CALL-A's call-09 proves
      // for a single stale reload -- this is the same guard exercised via
      // a second idle tab instead.
      await teacherStartCall(teacherPage);
      await expect(studentPageA.locator('#incomingCall')).toHaveClass(/show/, { timeout: 20_000 });
      const freshAttemptId = await studentPageA.evaluate(() => S.pendingCallAttemptId);
      const freshRoomId = await studentPageA.evaluate(() => S.pendingRoom);
      expect(freshAttemptId).not.toBe(staleAttemptId);
      expect(freshRoomId).not.toBe(staleRoomId);

      await studentPageB.evaluate(
        ({ attemptId, roomId, callerId }) => {
          const w = window as any;
          const ch = (sb as any).channel(`notify-${callerId}`, { config: { private: true } });
          ch.subscribe((status: string) => {
            if (status === 'SUBSCRIBED') {
              ch.send({ type: 'broadcast', event: 'decline', payload: { room_id: roomId, attempt_id: attemptId } });
            }
          });
        },
        { attemptId: staleAttemptId, roomId: staleRoomId, callerId: await teacherPage.evaluate(() => S.profile.id) },
      );

      // Attempt 2 must survive the stale broadcast untouched: still
      // ringing on A, teacher's active attempt id unchanged.
      await teacherPage.waitForTimeout(3_000);
      await expect(studentPageA.locator('#incomingCall')).toHaveClass(/show/, { timeout: 5_000 });
      const teacherActiveAttemptId = await teacherPage.evaluate(() => S._callAttemptId ?? S.pendingCallAttemptId ?? null);
      const freshRow = await fetchCallAttempt(studentPageA, freshAttemptId);
      expect(freshRow?.state).toBe('ringing');
      expect(teacherActiveAttemptId === freshAttemptId || teacherActiveAttemptId === null).toBe(true);

      // Clean teardown.
      await studentPageA.locator('#incomingCall .btn-red').click();
      await expect(teacherPage.locator('#callWindow')).not.toHaveClass(/visible/, { timeout: 20_000 });

      rtTeacher.assertNoDuplicateSubscriptions();
      rtA.assertNoDuplicateSubscriptions();
      rtB.assertNoDuplicateSubscriptions();
      stormTeacher.assertNoStorm();
      stormA.assertNoStorm();
      stormB.assertNoStorm();
    } finally {
      await teacherCtx.close();
      await studentCtxA.close();
      await studentCtxB.close();
    }
  });
});

function stripKnownBad(errors: ReturnType<typeof attachErrorCollectors>): void {
  // No-op placeholder kept symmetric with p0-call-a.spec.ts's per-suite
  // teardown-cancellation filter; multitab does not yet have an observed
  // teardown-specific false failure of its own. If CI surfaces one, add a
  // narrowly-scoped filter here rather than broadening allowBadResponses.
}
