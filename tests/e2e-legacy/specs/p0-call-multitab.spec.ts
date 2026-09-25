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

// NOTE: room_id is derived deterministically from the sorted pair of
// participant ids (see index.html's getRoomId()) -- it is NOT unique per
// call, it is stable for every call ever made between the same two people.
// A long-lived staging fixture pair accumulates many historical (terminal)
// rows for the same room_id across CI runs, so counting *all* rows for a
// room is not a meaningful invariant here. What the app actually
// guarantees is at most one *non-terminal* (active) attempt per room at a
// time -- so this only counts rows still in a non-terminal state, which is
// what "exactly one attempt was created for this call" means in practice.
async function countActiveCallAttemptsForRoom(page: Page, roomId: string): Promise<number> {
  return page.evaluate(async (rid) => {
    const { data } = await (sb as any)
      .from('call_attempts')
      .select('id')
      .eq('room_id', rid)
      .in('state', ['ringing', 'accepted']);
    return Array.isArray(data) ? data.length : -1;
  }, roomId);
}

// Teacher starts a call the same way p0-call-a.spec.ts/p0-call-recovery.spec.ts
// do: open the first real (non-"create new class") class card, then click the
// call panel's call button. cvCallStudent() calls the single enrolled student
// directly when the class has exactly one student -- the same staging fixture
// class used by every other call-* spec in this suite.
async function captureCallHelperState(page: Page, label: string, terminalAttemptId?: string | null): Promise<Record<string, unknown>> {
  const snap = async () => {
    try {
      return await Promise.race([
        page.evaluate(() => ({
          url: location.href,
          callAttemptId: (window as any).S?._callAttemptId ?? null,
          pendingCallAttemptId: (window as any).S?.pendingCallAttemptId ?? null,
          inCall: (window as any).S?.inCall ?? null,
          callBusyFlag: (window as any).S?._callBusy ?? (window as any).S?.callLock ?? (window as any).S?._callLock ?? (window as any).S?._callStarting ?? null,
          callWindowVisible: document.getElementById('callWindow')?.classList.contains('visible') ?? null,
          incomingCallShown: document.getElementById('incomingCall')?.classList.contains('show') ?? null,
          jitsiSrc: (document.getElementById('jitsiFrame') as HTMLIFrameElement | null)?.src ?? null,
          openModalCount: document.querySelectorAll('.modal.show, .modal.visible, [aria-modal="true"]').length,
          classCardCount: document.querySelectorAll('.ev-class-card:not(.ev-class-create)').length,
          callPanelPresent: !!document.getElementById('cv_callPanel'),
          callBtnCount: document.querySelectorAll('#cv_callPanel .cv-call-btn').length,
        })),
        new Promise((_, reject) => setTimeout(() => reject(new Error('state-snapshot-timeout')), 4_000)),
      ]);
    } catch (e) {
      return { error: (e as Error).message };
    }
  };
  const state = await snap();
  let call1Row: unknown = null;
  if (terminalAttemptId) {
    try {
      call1Row = await Promise.race([
        fetchCallAttempt(page, terminalAttemptId),
        new Promise((_, reject) => setTimeout(() => reject(new Error('row-fetch-timeout')), 4_000)),
      ]);
    } catch (e) {
      call1Row = { error: (e as Error).message };
    }
  }
  return { label, ...(state as object), call1_terminal_row: call1Row };
}

async function teacherStartCall(teacherPage: Page, priorCallAttemptId?: string | null): Promise<void> {
  const cardLoc = teacherPage.locator('.ev-class-card:not(.ev-class-create)').first();
  const panelLoc = teacherPage.locator('#cv_callPanel');
  const btnLoc = teacherPage.locator('#cv_callPanel .cv-call-btn');

  try {
    await expect(cardLoc).toBeVisible({ timeout: 15_000 });
  } catch (e) {
    const count = await cardLoc.count().catch(() => -1);
    const state = await captureCallHelperState(teacherPage, 'class-card-visible-wait-FAILED', priorCallAttemptId);
    throw new Error(`[teacherStartCall] class card never became visible (count=${count}). state=${JSON.stringify(state)}. ${(e as Error).message}`);
  }

  try {
    await cardLoc.click({ timeout: 15_000 });
  } catch (e) {
    const state = await captureCallHelperState(teacherPage, 'click-class-card-FAILED', priorCallAttemptId);
    throw new Error(`[teacherStartCall] click on class card failed/timed out. state=${JSON.stringify(state)}. ${(e as Error).message}`);
  }

  try {
    await expect(panelLoc).toBeVisible({ timeout: 15_000 });
  } catch (e) {
    const count = await panelLoc.count().catch(() => -1);
    const state = await captureCallHelperState(teacherPage, 'cv_callPanel-visible-wait-FAILED', priorCallAttemptId);
    throw new Error(`[teacherStartCall] #cv_callPanel never became visible after class card click (count=${count}). state=${JSON.stringify(state)}. ${(e as Error).message}`);
  }

  try {
    await expect(btnLoc).toBeVisible({ timeout: 15_000 });
    await expect(btnLoc).toBeEnabled({ timeout: 15_000 });
  } catch (e) {
    const count = await btnLoc.count().catch(() => -1);
    const state = await captureCallHelperState(teacherPage, 'call-btn-visible-enabled-wait-FAILED', priorCallAttemptId);
    throw new Error(`[teacherStartCall] .cv-call-btn never became visible/enabled (count=${count}). state=${JSON.stringify(state)}. ${(e as Error).message}`);
  }

  try {
    await btnLoc.click({ timeout: 15_000 });
  } catch (e) {
    const state = await captureCallHelperState(teacherPage, 'click-call-btn-FAILED', priorCallAttemptId);
    throw new Error(`[teacherStartCall] click on call button failed/timed out. state=${JSON.stringify(state)}. ${(e as Error).message}`);
  }
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

      const rowCount = await countActiveCallAttemptsForRoom(studentPageA, roomA);
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
    // Diagnostic instrumentation (test-only, no app changes): this test has
    // been hitting Playwright's global 90s test timeout with no further
    // detail on every observed run. Per-step bounded timeouts (all well
    // below 90s) plus explicit checkpoint tracking mean that whichever
    // await actually hangs will report its own informative timeout error
    // (with the last completed checkpoint and a best-effort snapshot of
    // page state / the relevant call_attempts row attached) well before the
    // global timeout could fire and swallow that detail. This does not
    // change what is asserted anywhere in this test.
    const teacherCtx = await browser.newContext();
    const studentCtxA = await browser.newContext();
    const studentCtxB = await browser.newContext();
    const teacherPage = await teacherCtx.newPage();
    const studentPageA = await studentCtxA.newPage();
    const studentPageB = await studentCtxB.newPage();

    let lastCheckpoint = 'contexts-created';
    const checkpoints: string[] = [lastCheckpoint];
    function checkpoint(name: string): void {
      lastCheckpoint = name;
      checkpoints.push(name);
    }

    async function captureFailureState(attemptId?: string | null): Promise<string> {
      const snap = async (page: Page) => {
        try {
          return await Promise.race([
            page.evaluate(() => ({
              url: location.href,
              inCall: (window as any).S?.inCall,
              pendingCallAttemptId: (window as any).S?.pendingCallAttemptId,
              callAttemptId: (window as any).S?._callAttemptId,
              incomingCallShown: document.getElementById('incomingCall')?.classList.contains('show') ?? null,
              jitsiSrc: (document.getElementById('jitsiFrame') as HTMLIFrameElement | null)?.src ?? null,
              callWindowVisible: document.getElementById('callWindow')?.classList.contains('visible') ?? null,
            })),
            new Promise((_, reject) => setTimeout(() => reject(new Error('snapshot-timeout')), 5_000)),
          ]);
        } catch (e) {
          return { error: (e as Error).message };
        }
      };
      const [teacherSnap, aSnap, bSnap] = await Promise.all([snap(teacherPage), snap(studentPageA), snap(studentPageB)]);
      let row: unknown = null;
      if (attemptId) {
        try {
          row = await Promise.race([
            fetchCallAttempt(teacherPage, attemptId),
            new Promise((_, reject) => setTimeout(() => reject(new Error('row-fetch-timeout')), 5_000)),
          ]);
        } catch (e) {
          row = { error: (e as Error).message };
        }
      }
      return JSON.stringify(
        { lastCheckpoint, checkpoints, teacherSnap, aSnap, bSnap, attemptId: attemptId ?? null, call_attempts_row: row },
        null,
        2,
      );
    }

    try {
      const rtTeacher = attachRealtimeSubscriptionTracker(teacherPage);
      const rtA = attachRealtimeSubscriptionTracker(studentPageA);
      const rtB = attachRealtimeSubscriptionTracker(studentPageB);
      const stormTeacher = attachRequestStormDetector(teacherPage);
      const stormA = attachRequestStormDetector(studentPageA);
      const stormB = attachRequestStormDetector(studentPageB);

      await test.step('login all three sessions', async () => {
        await Promise.all([loginFresh(teacherPage, teacherCreds), loginFresh(studentPageA, studentCreds), loginFresh(studentPageB, studentCreds)]);
        checkpoint('logged-in');
      });

      // Call 1: A accepts, teacher hangs up. B never acts -- it holds a
      // stale S.pendingCallAttemptId for an attempt that is about to be
      // terminated by someone else's action, the exact scenario this test
      // exists to check.
      let staleAttemptId = '';
      let staleRoomId = '';

      await test.step('call 1: teacher starts call', async () => {
        await teacherStartCall(teacherPage);
        checkpoint('call1-start_call-invoked');
      });

      await test.step('call 1: ring reaches student A', async () => {
        try {
          await expect(studentPageA.locator('#incomingCall')).toHaveClass(/show/, { timeout: 20_000 });
        } catch (e) {
          throw new Error(`[${lastCheckpoint}] call 1 never rang on A: ${(e as Error).message}\n${await captureFailureState()}`);
        }
        checkpoint('call1-rang-on-A');
      });

      await test.step('call 1: ring reaches student B', async () => {
        try {
          await expect(studentPageB.locator('#incomingCall')).toHaveClass(/show/, { timeout: 20_000 });
        } catch (e) {
          throw new Error(`[${lastCheckpoint}] call 1 never rang on B: ${(e as Error).message}\n${await captureFailureState()}`);
        }
        checkpoint('call1-rang-on-B');
      });

      staleAttemptId = await studentPageB.evaluate(() => S.pendingCallAttemptId);
      staleRoomId = await studentPageB.evaluate(() => S.pendingRoom);
      checkpoint(`call1-stale-ids-captured(attempt=${staleAttemptId})`);

      await test.step('call 1: student A accepts', async () => {
        await studentPageA.locator('#incomingCall .btn-green').click();
        checkpoint('call1-A-clicked-accept');
      });

      await test.step('call 1: Daily room opens on A', async () => {
        try {
          await expect(studentPageA.locator('#jitsiFrame')).toHaveAttribute('src', /daily\.co/, { timeout: 15_000 });
        } catch (e) {
          throw new Error(`[${lastCheckpoint}] Daily room never opened on A after accept: ${(e as Error).message}\n${await captureFailureState(staleAttemptId)}`);
        }
        checkpoint('call1-daily-open-on-A');
      });

      await test.step('call 1: incoming UI closes on B', async () => {
        try {
          await expect(studentPageB.locator('#incomingCall')).not.toHaveClass(/show/, { timeout: 20_000 });
        } catch (e) {
          throw new Error(`[${lastCheckpoint}] incoming UI did not close on B after A accepted: ${(e as Error).message}\n${await captureFailureState(staleAttemptId)}`);
        }
        checkpoint('call1-incoming-closed-on-B');
      });

      await test.step('call 1: teacher hangs up', async () => {
        await teacherPage.evaluate(() => (window as any).hangUp());
        checkpoint('call1-teacher-hangup-invoked');
      });

      await test.step('call 1: Daily room closes on A', async () => {
        try {
          await expect(studentPageA.locator('#jitsiFrame')).not.toHaveAttribute('src', /daily\.co/, { timeout: 20_000 });
        } catch (e) {
          throw new Error(`[${lastCheckpoint}] Daily room did not close on A after teacher hangup: ${(e as Error).message}\n${await captureFailureState(staleAttemptId)}`);
        }
        checkpoint('call1-daily-closed-on-A');
      });

      await test.step('call 1: verify terminal state in DB', async () => {
        const endedRow = await fetchCallAttempt(studentPageA, staleAttemptId);
        expect(['ended', 'declined']).toContain(endedRow?.state);
        checkpoint('call1-db-terminal-confirmed');
      });

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
      let call2StartCallRequests = 0;
      let call2StartCallLastStatus: number | null = null;
      const call2ReqListener = (req: any) => {
        if (req.url().includes('/rest/v1/rpc/start_call') && req.method() === 'POST') call2StartCallRequests++;
      };
      const call2ResListener = (res: any) => {
        if (res.url().includes('/rest/v1/rpc/start_call')) call2StartCallLastStatus = res.status();
      };
      teacherPage.on('request', call2ReqListener);
      teacherPage.on('response', call2ResListener);

      await test.step('call 2: teacher starts call', async () => {
        await teacherStartCall(teacherPage, staleAttemptId);
        checkpoint('call2-start_call-invoked');
      });

      await test.step('call 2: ring reaches student A', async () => {
        try {
          await expect(studentPageA.locator('#incomingCall')).toHaveClass(/show/, { timeout: 20_000 });
        } catch (e) {
          const diag = await teacherPage
            .evaluate(() => ({
              inCall: (window as any).S?.inCall,
              pendingCallAttemptId: (window as any).S?.pendingCallAttemptId,
              callAttemptId: (window as any).S?._callAttemptId,
            }))
            .catch((err) => ({ error: (err as Error).message }));
          throw new Error(
            `[${lastCheckpoint}] call 2 never rang on A. start_call RPC requests seen: ${call2StartCallRequests}, last response status: ${call2StartCallLastStatus}. teacherPage state: ${JSON.stringify(diag)}. Original error: ${(e as Error).message}\n${await captureFailureState(staleAttemptId)}`,
          );
        } finally {
          teacherPage.off('request', call2ReqListener);
          teacherPage.off('response', call2ResListener);
        }
        checkpoint('call2-rang-on-A');
      });

      const freshAttemptId = await studentPageA.evaluate(() => S.pendingCallAttemptId);
      const freshRoomId = await studentPageA.evaluate(() => S.pendingRoom);
      expect(freshAttemptId).not.toBe(staleAttemptId);
      // NOTE: room_id is deterministic per (caller, callee) pair (see
      // index.html's getRoomId()) -- calling the same student again
      // legitimately reuses the same room_id. The room is intentionally
      // NOT asserted to differ here; attempt_id is what must be unique per
      // call, which is exactly what the guard below (the stale broadcast
      // must be ignored because its attempt_id no longer matches the
      // caller's active attempt) actually depends on.
      expect(freshRoomId).toBe(staleRoomId);
      checkpoint(`call2-fresh-ids-captured(attempt=${freshAttemptId})`);

      await test.step('call 2: B sends stale decline broadcast for attempt 1', async () => {
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
        checkpoint('call2-stale-decline-sent');
      });

      // Attempt 2 must survive the stale broadcast untouched: still
      // ringing on A, teacher's active attempt id unchanged.
      await test.step('call 2: wait for stale broadcast to (not) affect state', async () => {
        await teacherPage.waitForTimeout(3_000);
        checkpoint('call2-post-stale-wait');
      });

      await test.step('call 2: verify A survives stale broadcast', async () => {
        try {
          await expect(studentPageA.locator('#incomingCall')).toHaveClass(/show/, { timeout: 5_000 });
        } catch (e) {
          throw new Error(`[${lastCheckpoint}] A's ring did not survive the stale decline broadcast: ${(e as Error).message}\n${await captureFailureState(freshAttemptId)}`);
        }
        checkpoint('call2-A-survived-stale-broadcast');
      });

      const teacherActiveAttemptId = await teacherPage.evaluate(() => S._callAttemptId ?? S.pendingCallAttemptId ?? null);

      await test.step('call 2: verify DB state still ringing', async () => {
        const freshRow = await fetchCallAttempt(studentPageA, freshAttemptId);
        expect(freshRow?.state).toBe('ringing');
        expect(teacherActiveAttemptId === freshAttemptId || teacherActiveAttemptId === null).toBe(true);
        checkpoint('call2-db-still-ringing-confirmed');
      });

      // Clean teardown.
      await test.step('call 2: teardown - student A declines', async () => {
        await studentPageA.locator('#incomingCall .btn-red').click();
        checkpoint('call2-A-clicked-decline');
      });

      await test.step('call 2: teardown - teacher call window closes', async () => {
        try {
          await expect(teacherPage.locator('#callWindow')).not.toHaveClass(/visible/, { timeout: 20_000 });
        } catch (e) {
          throw new Error(`[${lastCheckpoint}] teacher call window did not close after A declined: ${(e as Error).message}\n${await captureFailureState(freshAttemptId)}`);
        }
        checkpoint('call2-teardown-complete');
      });

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
