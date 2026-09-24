import { test, expect, type Page } from '@playwright/test';
import { attachErrorCollectors, assertNoUnexpectedErrors } from '../helpers/error-collectors';
import { attachRequestStormDetector, attachRealtimeSubscriptionTracker } from '../helpers/request-storm-detector';
import { login, requireTeacherCredentials, requireStudentCredentials } from '../helpers/auth';

// CALL-A -- 1:1 call signalling stability (call-01..call-09), without
// accept/Daily-media assertions (that is CALL-B, not implemented here).
//
// Source-traced against live index.html on branch call-attempts-architecture
// (real UI, real call_attempts, real Realtime, real daily-room invocation on
// the caller side -- no internal function is invoked directly for a user
// action; the only functions called from test code are read-only
// diagnostics, one direct start_call RPC call for call-04's identity-spoof
// check, and the construction of one deliberately-stale Realtime broadcast
// in the main scenario, explained in detail at that point below).
//
// call_attempts replaces call_signals as the authoritative signaling table
// as of this spec version -- see the client migration this spec was
// rewritten alongside. Unlike call_signals, call_attempts rows are durable
// (never deleted by either party), so this spec both captures the real
// POST request to /rest/v1/rpc/start_call AND reads the row back afterward
// via the page's own authenticated \`sb\` client (RLS permits this: both
// caller and callee are participants).
//
// UI path traced from index.html (unchanged from the prior version of this
// spec):
//   - Caller: click a \`.ev-class-card\` on the teacher's "Классы" screen
//     (the default post-login landing screen) -> onclick="enterClassLesson(classId)"
//     -> openClassroomView(...) shows #classroomView (adds class "open") and
//     wires \`#cv_callPanel .cv-call-btn\` to cvCallStudent() for the teacher
//     role. The legacy global \`#dialBtn\` + \`#contactPicker\` dial-anyone UI
//     is dead code (CSS-hidden, nothing un-hides it) -- NOT used here.
//   - cvCallStudent(): if the class has exactly one student, calls them
//     directly; otherwise falls back to opening \`#contactPicker\` for a
//     manual pick. Either way it ends by calling callContact(id,name,role)
//     -- the real, unmodified app function invoked by a real click.
//   - callContact(): resolves the callee's real profile id, then AWAITS
//     sb.rpc('start_call',{p_id,p_room_id,p_callee_profile_id}) -- the
//     call_attempts row is confirmed committed (row must exist, in state
//     'ringing') BEFORE the Broadcast ring is sent and before initCall()
//     (media init / daily-room invoke) runs. start_call derives
//     caller_profile_id from auth.uid() server-side -- never from
//     anything the client sends -- which is what call-04 below verifies
//     directly via RPC, not just by observation.
//   - Recipient: handleIncomingCall(payload) is reached via up to two
//     independent delivery paths now -- a postgres_changes INSERT on
//     call_attempts (filtered to callee_profile_id = me), and a Broadcast
//     'ring' handler that now trusts the broadcast payload directly
//     (attempt_id is always present, set server-side by start_call's
//     return value). A built-in guard (\`if(S.inCall||S.pendingRoom)return;\`)
//     means only the first delivery path to arrive actually shows the
//     incoming-call UI; the other silently no-ops.
//   - Recipient declines via the real button (\`#incomingCall .btn-red\`,
//     onclick="declineCall()"). declineCall() captures the then-current
//     S.pendingRoom/S.pendingCallAttemptId/S.pendingCallerId, clears that
//     state, calls the decline_call RPC (authoritative), and also sends a
//     'decline' broadcast on \`notify-<callerId>\` (fast path only).
//   - Caller's decline handling (inside _ensureBcNotifyChannel's 'decline'
//     handler, or the postgres_changes UPDATE listener in
//     _ensureCallAttemptsChannel) hands off to _reconcileCallAttempt(id),
//     which only acts if the attempt id strictly equals the caller's
//     *current* S._callAttemptId -- this exact check is what call-09
//     (stale decline immunity) below exercises for real.
//
// Instrumentation strategy (read-only observation, never used to trigger a
// user action or bypass any correlation/authorization logic) -- unchanged
// in spirit from the prior version: window.handleIncomingCall,
// window.declineCall, window.hangUp are \`function\` declarations at the top
// level of index.html's classic <script> tag, so they ARE plain \`window\`
// properties (function declarations create global-object properties;
// \`const\`/\`let\` -- like \`sb\` -- do not). Each is wrapped here to push a
// timestamped record of the real arguments/state the app itself observed,
// then calls straight through via .apply(this, arguments) -- functional
// behavior is unchanged, this only adds an observer.
//
// call-02's "exactly one call_attempts row created per attempt" is
// asserted two ways: the real POST request to '/rest/v1/rpc/start_call'
// the browser actually sent (count + body), AND a read-back of the actual
// call_attempts row via the page's own \`sb\` client (safe now that the row
// is durable, unlike call_signals).
//
// The main scenario's stale-decline construction (documented in detail at
// its call site below) sends one real Realtime broadcast frame, via the
// same \`sb.channel(name,{config:{private:true}}).send({type:'broadcast',...})\`
// API declineCall() itself uses, carrying attempt 1's now-superseded
// {room_id, attempt_id}. This is real wire traffic processed by the real,
// unmodified caller-side handler; only the *sender* of an already-late
// duplicate is synthesized (standing in for a real-world network
// retry/race), never the receiver's correlation logic, and hangUp() is
// never called directly by test code anywhere in this file.

const teacherCreds = requireTeacherCredentials();
const studentCreds = requireStudentCredentials();

interface IncomingRecord {
  ts: number;
  wouldProceed: boolean;
  payload: { from_id: string | null; from_name: string | null; from_role: string | null; room_id: string | null; attempt_id: string | null };
}
interface DeclineRecord {
  ts: number;
  room_id: string | null;
  attempt_id: string | null;
  caller_id: string | null;
}
interface HangupRecord {
  ts: number;
  callRoomId: string | null;
  callAttemptId: string | null;
  inCall: boolean;
}
interface StartCallRPCRecord {
  url: string;
  ts: number;
  body: { p_id: string | null; p_room_id: string | null; p_callee_profile_id: string | null } | null;
}

declare const S: any;
declare const sb: any;

async function waitForNotifyReady(page: Page): Promise<void> {
  try {
    await page.waitForFunction(
      () => typeof S !== 'undefined' && S._notifyReady === true && S._bcState === 'healthy',
      null,
      { timeout: 20_000 },
    );
  } catch (err) {
    const diag = await page.evaluate(() => {
      const hasS = typeof S !== 'undefined';
      return {
        hasS,
        notifyReady: hasS ? (S._notifyReady ?? null) : null,
        bcState: hasS ? (S._bcState ?? null) : null,
        caState: hasS ? (S._caState ?? null) : null,
        profileId: hasS ? (S.profile?.id ?? null) : null,
        profileRole: hasS ? (S.role ?? null) : null,
      };
    });
    console.log('[call-a] waitForNotifyReady timeout diagnostics:\n' + JSON.stringify(diag, null, 2));
    throw err;
  }
}

async function getOwnProfile(page: Page): Promise<{ id: string; first_name: string; last_name: string }> {
  return page.evaluate(() => {
    const s = S;
    return { id: s.profile.id, first_name: s.profile.first_name, last_name: s.profile.last_name };
  });
}

async function installStudentDiagnostics(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as any;
    w.__diag = { incoming: [] as any[], declines: [] as any[] };
    const origHandle = w.handleIncomingCall;
    w.handleIncomingCall = function (payload: any) {
      const s = S;
      const wouldProceed = !(s.inCall || s.pendingRoom);
      w.__diag.incoming.push({
        ts: Date.now(),
        wouldProceed,
        payload: {
          from_id: payload?.from_id ?? null,
          from_name: payload?.from_name ?? null,
          from_role: payload?.from_role ?? null,
          room_id: payload?.room_id ?? null,
          attempt_id: payload?.attempt_id ?? null,
        },
      });
      return origHandle.apply(this, arguments as any);
    };
    const origDecline = w.declineCall;
    w.declineCall = function () {
      const s = S;
      w.__diag.declines.push({
        ts: Date.now(),
        room_id: s.pendingRoom ?? null,
        attempt_id: s.pendingCallAttemptId ?? null,
        caller_id: s.pendingCallerId ?? null,
      });
      return origDecline.apply(this, arguments as any);
    };
  });
}

async function installTeacherDiagnostics(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as any;
    w.__diag = { hangups: [] as { ts: number; callRoomId: any; callAttemptId: any; inCall: any }[] };
    const origHang = w.hangUp;
    w.hangUp = function () {
      const s = S;
      w.__diag.hangups.push({ ts: Date.now(), callRoomId: s._callRoomId ?? null, callAttemptId: s._callAttemptId ?? null, inCall: s.inCall });
      return origHang.apply(this, arguments as any);
    };
  });
}

async function ringPickerOrIncoming(teacherPage: Page, studentPage: Page, studentProfileId: string): Promise<void> {
  const which = await Promise.race([
    teacherPage
      .locator('#contactPicker.open')
      .waitFor({ state: 'attached', timeout: 20_000 })
      .then(() => 'picker' as const)
      .catch(() => null),
    studentPage
      .locator('#incomingCall.show')
      .waitFor({ state: 'attached', timeout: 20_000 })
      .then(() => 'incoming' as const)
      .catch(() => null),
  ]);
  if (which === 'picker') {
    await teacherPage.locator(\`.contact-item[data-cid="\${studentProfileId}"]\`).click();
  }
}

async function fetchCallAttempt(page: Page, id: string): Promise<{ state: string; room_id: string; caller_profile_id: string; callee_profile_id: string } | null> {
  return page.evaluate(async (attemptId) => {
    const { data } = await (sb as any).from('call_attempts').select('state,room_id,caller_profile_id,callee_profile_id').eq('id', attemptId).maybeSingle();
    return data ?? null;
  }, id);
}

test.describe('CALL-A -- 1:1 call signalling stability (call-01..call-09, no accept/media)', () => {
  test('call-04: caller identity is server-enforced by start_call, not client-suppliable', async ({ browser }) => {
    const studentContext = await browser.newContext();
    const studentPage = await studentContext.newPage();
    try {
      await login(studentPage, studentCreds);
      const me = await getOwnProfile(studentPage);
      const result = await studentPage.evaluate(async (meId: string) => {
        const attemptId = crypto.randomUUID();
        const { data, error } = await (sb as any).rpc('start_call', {
          p_id: attemptId,
          p_room_id: \`room-call04-\${attemptId}\`,
          p_callee_profile_id: meId,
        });
        return { error: error?.message ?? null, row: data ?? null };
      }, me.id);
      expect(result.error).toBeTruthy();
      expect(result.row).toBeNull();
    } finally {
      await studentContext.close();
    }
  });

  test('teacher -> student: real call, student declines; then a second call proves stale-decline immunity', async ({ browser }) => {
    const teacherContext = await browser.newContext();
    const studentContext = await browser.newContext();
    const teacherPage = await teacherContext.newPage();
    const studentPage = await studentContext.newPage();

    const teacherErrors = attachErrorCollectors(teacherPage);
    const studentErrors = attachErrorCollectors(studentPage);
    const teacherStorm = attachRequestStormDetector(teacherPage);
    const studentStorm = attachRequestStormDetector(studentPage);
    const teacherRt = attachRealtimeSubscriptionTracker(teacherPage);
    const studentRt = attachRealtimeSubscriptionTracker(studentPage);

    const teacherStartCallRPCs: StartCallRPCRecord[] = [];
    teacherPage.on('request', (req) => {
      if (req.method() === 'POST' && req.url().includes('/rest/v1/rpc/start_call')) {
        let body: StartCallRPCRecord['body'] = null;
        try {
          const parsed = req.postDataJSON();
          if (parsed && typeof parsed === 'object') {
            body = {
              p_id: parsed.p_id ?? null,
              p_room_id: parsed.p_room_id ?? null,
              p_callee_profile_id: parsed.p_callee_profile_id ?? null,
            };
          }
        } catch {
          body = null;
        }
        teacherStartCallRPCs.push({ url: req.url(), ts: Date.now(), body });
      }
    });

    const teacherDailyRoomFailures: { url: string; ts: number; errorText: string | null }[] = [];
    teacherPage.on('requestfailed', (req) => {
      if (req.url().includes('/functions/v1/daily-room')) {
        teacherDailyRoomFailures.push({ url: req.url(), ts: Date.now(), errorText: req.failure()?.errorText ?? null });
        console.log('[call-a] daily-room requestfailed: ' + JSON.stringify(req.failure()));
      }
    });

    try {
      await Promise.all([login(teacherPage, teacherCreds), login(studentPage, studentCreds)]);
      await Promise.all([waitForNotifyReady(teacherPage), waitForNotifyReady(studentPage)]);

      const teacherProfile = await getOwnProfile(teacherPage);
      const studentProfile = await getOwnProfile(studentPage);

      await installStudentDiagnostics(studentPage);
      await installTeacherDiagnostics(teacherPage);

      await teacherPage.waitForFunction(
        (sid) => Array.isArray(S.contacts) && S.contacts.some((c: any) => c.id === sid),
        studentProfile.id,
        { timeout: 20_000 },
      );

      const attempt1CountBefore = teacherStartCallRPCs.length;
      const attempt1RingTs = Date.now();

      await teacherPage.locator('.ev-class-card:not(.ev-class-create)').first().click();
      await expect(teacherPage.locator('#classroomView')).toHaveClass(/open/);
      const callBtn = teacherPage.locator('#cv_callPanel .cv-call-btn');
      await expect(callBtn).toBeVisible();
      await expect(callBtn).toBeEnabled();
      await callBtn.click();
      await ringPickerOrIncoming(teacherPage, studentPage, studentProfile.id);

      await expect(studentPage.locator('#incomingCall')).toHaveClass(/show/, { timeout: 20_000 });

      const attempt1CountAfter = teacherStartCallRPCs.length;
      expect(attempt1CountAfter - attempt1CountBefore).toBe(1);

      const attempt1Rpc = teacherStartCallRPCs[attempt1CountBefore];
      expect(attempt1Rpc).toBeTruthy();
      expect(attempt1Rpc.body).toBeTruthy();
      const attempt1 = {
        id: attempt1Rpc.body!.p_id,
        roomId: attempt1Rpc.body!.p_room_id,
        calleeId: attempt1Rpc.body!.p_callee_profile_id,
      };
      expect(attempt1.id).toBeTruthy();
      expect(attempt1.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      expect(attempt1.roomId).toBeTruthy();
      expect(attempt1.calleeId).toBe(studentProfile.id);

      const attempt1Row = await fetchCallAttempt(studentPage, attempt1.id!);
      expect(attempt1Row).toBeTruthy();
      expect(attempt1Row!.state).toBe('ringing');
      expect(attempt1Row!.caller_profile_id).toBe(teacherProfile.id);
      expect(attempt1Row!.callee_profile_id).toBe(studentProfile.id);
      expect(attempt1Row!.room_id).toBe(attempt1.roomId);

      const studentDiagAfterRing = await studentPage.evaluate(() => (window as any).__diag);
      const provenIncoming = (studentDiagAfterRing.incoming as IncomingRecord[]).filter((r) => r.wouldProceed);
      expect(provenIncoming.length).toBe(1);
      expect(provenIncoming[0].payload.from_id).toBe(teacherProfile.id);
      expect(provenIncoming[0].payload.room_id).toBe(attempt1.roomId);
      expect(provenIncoming[0].payload.attempt_id).toBe(attempt1.id);

      let jitsiSrc: string | null = null;
      const daily_deadline = Date.now() + 15_000;
      while (Date.now() < daily_deadline) {
        jitsiSrc = await teacherPage.evaluate(() => (document.getElementById('jitsiFrame') as HTMLIFrameElement | null)?.src ?? null);
        if (jitsiSrc && jitsiSrc !== 'about:blank') break;
        const hangupsSoFar = await teacherPage.evaluate(() => (window as any).__diag.hangups.length);
        if (hangupsSoFar > 0) break;
        await teacherPage.waitForTimeout(250);
      }
      const teacherDiagAfterCall = await teacherPage.evaluate(() => (window as any).__diag);
      console.log(
        '[call-a] attempt-1 caller state:\n' +
          JSON.stringify({ attempt1, jitsiSrc, hangups: teacherDiagAfterCall.hangups, dailyRoomFailures: teacherDailyRoomFailures }, null, 2),
      );
      expect(teacherDiagAfterCall.hangups.length).toBe(0);
      expect(jitsiSrc).toBeTruthy();
      expect(jitsiSrc).not.toBe('about:blank');

      const callerStillActiveBeforeDecline = await teacherPage.evaluate(() => ({
        inCall: S.inCall,
        hangupsSoFar: (window as any).__diag.hangups.length,
      }));
      expect(callerStillActiveBeforeDecline.hangupsSoFar).toBe(0);
      expect(callerStillActiveBeforeDecline.inCall).toBe(true);

      const attempt1DeclineTs = Date.now();
      await studentPage.locator('#incomingCall .btn-red').click();

      await expect(teacherPage.locator('#callWindow')).not.toHaveClass(/visible/, { timeout: 20_000 });

      const studentDiagAfterDecline = await studentPage.evaluate(() => (window as any).__diag);
      const decline1 = (studentDiagAfterDecline.declines as DeclineRecord[])[0];
      expect(decline1).toBeTruthy();
      expect(decline1.room_id).toBe(attempt1.roomId);
      expect(decline1.attempt_id).toBe(attempt1.id);
      expect(decline1.caller_id).toBe(teacherProfile.id);

      const teacherDiagAfterDecline = await teacherPage.evaluate(() => (window as any).__diag);
      const hangup1 = (teacherDiagAfterDecline.hangups as HangupRecord[])[0];
      expect(hangup1).toBeTruthy();
      const attempt1CloseTs = hangup1.ts;

      await expect
        .poll(async () => (await fetchCallAttempt(teacherPage, attempt1.id!))?.state)
        .toBe('declined');

      await expect.poll(async () => teacherPage.evaluate(() => S.inCall)).toBe(false);
      await expect.poll(async () => studentPage.evaluate(() => S.pendingRoom)).toBeNull();
      await expect(studentPage.locator('#incomingCall')).not.toHaveClass(/show/);

      console.log(
        '[call-a] attempt 1 timeline:\n' +
          JSON.stringify(
            { attemptId: attempt1.id, roomId: attempt1.roomId, recipientId: studentProfile.id, fromProfileId: provenIncoming[0].payload.from_id, ringTs: attempt1RingTs, declineTs: attempt1DeclineTs, callerCloseTs: attempt1CloseTs },
            null,
            2,
          ),
      );

      const attempt2CountBefore = teacherStartCallRPCs.length;
      const attempt2RingTs = Date.now();

      const callBtn2 = teacherPage.locator('#cv_callPanel .cv-call-btn');
      await expect(callBtn2).toBeVisible();
      await expect(callBtn2).toBeEnabled();
      await callBtn2.click();
      await ringPickerOrIncoming(teacherPage, studentPage, studentProfile.id);

      await expect(studentPage.locator('#incomingCall')).toHaveClass(/show/, { timeout: 20_000 });

      const attempt2CountAfter = teacherStartCallRPCs.length;
      expect(attempt2CountAfter - attempt2CountBefore).toBe(1);

      const attempt2Rpc = teacherStartCallRPCs[attempt2CountBefore];
      expect(attempt2Rpc).toBeTruthy();
      expect(attempt2Rpc.body).toBeTruthy();
      const attempt2 = {
        id: attempt2Rpc.body!.p_id,
        roomId: attempt2Rpc.body!.p_room_id,
        calleeId: attempt2Rpc.body!.p_callee_profile_id,
      };
      expect(attempt2.id).toBeTruthy();
      expect(attempt2.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      expect(attempt2.id).not.toBe(attempt1.id);
      expect(attempt2.roomId).toBe(attempt1.roomId);
      expect(attempt2.calleeId).toBe(studentProfile.id);

      const attempt2Row = await fetchCallAttempt(studentPage, attempt2.id!);
      expect(attempt2Row).toBeTruthy();
      expect(attempt2Row!.state).toBe('ringing');

      const studentDiagAfterRing2 = await studentPage.evaluate(() => (window as any).__diag);
      const provenIncoming2 = (studentDiagAfterRing2.incoming as IncomingRecord[]).filter((r) => r.wouldProceed);
      expect(provenIncoming2.length).toBe(2);
      const latestIncoming2 = provenIncoming2[1];
      expect(latestIncoming2.payload.from_id).toBe(teacherProfile.id);
      expect(latestIncoming2.payload.attempt_id).toBe(attempt2.id);

      await studentPage.evaluate(
        ({ callerId, roomId, attemptId }) => {
          const sb = (window as any).sb;
          return new Promise<void>((resolve, reject) => {
            const ch = sb.channel(\`notify-\${callerId}\`, { config: { private: true } });
            const timeout = setTimeout(() => reject(new Error('stale-decline channel subscribe timed out')), 10_000);
            ch.subscribe((status: string) => {
              if (status === 'SUBSCRIBED') {
                clearTimeout(timeout);
                ch.send({ type: 'broadcast', event: 'decline', payload: { room_id: roomId, attempt_id: attemptId } }).then(() => {
                  setTimeout(() => sb.removeChannel(ch), 1000);
                  resolve();
                });
              } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
                clearTimeout(timeout);
                reject(new Error(\`stale-decline channel subscribe failed: \${status}\`));
              }
            });
          });
        },
        { callerId: teacherProfile.id, roomId: attempt1.roomId, attemptId: attempt1.id },
      );

      await teacherPage.waitForTimeout(3_000);
      const teacherDiagAfterStale = await teacherPage.evaluate(() => (window as any).__diag);
      expect(teacherDiagAfterStale.hangups.length).toBe(1);
      const liveStateAfterStale = await teacherPage.evaluate(() => ({ inCall: S.inCall, roomId: S._callRoomId, attemptId: S._callAttemptId }));
      expect(liveStateAfterStale.inCall).toBe(true);
      expect(liveStateAfterStale.roomId).toBe(attempt2.roomId);
      expect(liveStateAfterStale.attemptId).toBe(attempt2.id);
      await expect(teacherPage.locator('#callWindow')).toHaveClass(/visible/);
      expect((await fetchCallAttempt(teacherPage, attempt2.id!))?.state).toBe('ringing');

      const attempt2DeclineTs = Date.now();
      await studentPage.locator('#incomingCall .btn-red').click();
      await expect(teacherPage.locator('#callWindow')).not.toHaveClass(/visible/, { timeout: 20_000 });

      const studentDiagAfterDecline2 = await studentPage.evaluate(() => (window as any).__diag);
      const decline2 = (studentDiagAfterDecline2.declines as DeclineRecord[])[1];
      expect(decline2).toBeTruthy();
      expect(decline2.room_id).toBe(attempt2.roomId);
      expect(decline2.attempt_id).toBe(attempt2.id);

      const teacherDiagFinal = await teacherPage.evaluate(() => (window as any).__diag);
      expect(teacherDiagFinal.hangups.length).toBe(2);
      const hangup2 = (teacherDiagFinal.hangups as HangupRecord[])[1];
      expect(hangup2).toBeTruthy();
      const attempt2CloseTs = hangup2.ts;

      await expect
        .poll(async () => (await fetchCallAttempt(teacherPage, attempt2.id!))?.state)
        .toBe('declined');
      expect((await fetchCallAttempt(teacherPage, attempt1.id!))?.state).toBe('declined');

      await expect.poll(async () => teacherPage.evaluate(() => S.inCall)).toBe(false);
      await expect.poll(async () => studentPage.evaluate(() => S.pendingRoom)).toBeNull();
      await expect(studentPage.locator('#incomingCall')).not.toHaveClass(/show/);

      console.log(
        '[call-a] attempt 2 timeline:\n' +
          JSON.stringify(
            { attemptId: attempt2.id, roomId: attempt2.roomId, recipientId: studentProfile.id, fromProfileId: latestIncoming2.payload.from_id, ringTs: attempt2RingTs, staleDeclineFromAttempt1: { roomId: attempt1.roomId, attemptId: attempt1.id }, declineTs: attempt2DeclineTs, callerCloseTs: attempt2CloseTs },
            null,
            2,
          ),
      );

      teacherStorm.assertNoStorm();
      studentStorm.assertNoStorm();
      teacherRt.assertNoDuplicateSubscriptions();
      studentRt.assertNoDuplicateSubscriptions();
      assertNoUnexpectedErrors(teacherErrors);
      assertNoUnexpectedErrors(studentErrors);

      console.log('[call-a] full teacher start_call RPC requests:\n' + JSON.stringify(teacherStartCallRPCs, null, 2));
    } finally {
      await teacherContext.close();
      await studentContext.close();
    }
  });
});
